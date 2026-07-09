// =============================================================================
// GET /api/export : JSONLダウンロード（要件定義書 4.6 準拠, Stage 5）
//   1. getAllowedUser() で認証+ホワイトリスト確認。非許可は401 JSON。
//   2. answers から status='submitted' かつ skipped=false の全行を seq昇順で取得し、
//      questions をアプリ側でjoinする（テーブル数が少なくコストが低いため）。
//   3. revision_of（uuid）は参照先回答の seq を要件定義書の id 形式("ans_%04d")に
//      変換する必要がある。参照先が skip 行などエクスポート対象外でも解決できるよう、
//      「全 answers 行の id→seq マップ」を別途取得して使う。
//   4. Content-Disposition: attachment でJSONLをダウンロードさせる。0件でも200+空ボディ。
// =============================================================================
import { NextResponse } from 'next/server';
import { getAllowedUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { buildJsonl, jstDateStamp, toExportRecord } from '@/lib/export';
import type { AnswerRow, ExportRecord, QuestionRow } from '@/lib/types';

const ANSWER_COLUMNS =
  'id, seq, question_id, user_id, status, answer_text, reason_text, choice, followup_q, followup_a, input_mode, skipped, skip_reason, revision_of, created_at, updated_at, submitted_at';

const QUESTION_COLUMNS = 'id, category, body, body_options, source, status, reject_reason, reask_after, created_at';

export async function GET() {
  const user = await getAllowedUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = await createClient();

  // revision_of 解決用: skipped行も参照され得るため、全 answers 行の id→seq を用意する。
  const { data: allAnswers, error: allAnswersError } = await supabase
    .from('answers')
    .select('id, seq')
    .eq('user_id', user.id);

  if (allAnswersError) {
    return NextResponse.json({ error: allAnswersError.message }, { status: 500 });
  }

  const idToSeq = new Map<string, number>();
  for (const row of allAnswers ?? []) {
    idToSeq.set(row.id as string, row.seq as number);
  }

  const { data: answersData, error: answersError } = await supabase
    .from('answers')
    .select(ANSWER_COLUMNS)
    .eq('user_id', user.id)
    .eq('status', 'submitted')
    .eq('skipped', false)
    .order('seq', { ascending: true });

  if (answersError) {
    return NextResponse.json({ error: answersError.message }, { status: 500 });
  }

  const answers = (answersData ?? []) as AnswerRow[];

  let questionMap = new Map<string, QuestionRow>();
  if (answers.length > 0) {
    const questionIds = Array.from(new Set(answers.map((a) => a.question_id)));
    const { data: questionsData, error: questionsError } = await supabase
      .from('questions')
      .select(QUESTION_COLUMNS)
      .in('id', questionIds);

    if (questionsError) {
      return NextResponse.json({ error: questionsError.message }, { status: 500 });
    }

    questionMap = new Map(
      ((questionsData ?? []) as QuestionRow[]).map((q) => [q.id, q]),
    );
  }

  const records: ExportRecord[] = [];
  for (const answer of answers) {
    const question = questionMap.get(answer.question_id);
    // FK制約上は必ず存在するはずだが、万一の不整合ではその行だけスキップする。
    if (!question) continue;

    const revisionOfSeq = answer.revision_of ? idToSeq.get(answer.revision_of) ?? null : null;
    records.push(toExportRecord(answer, question, revisionOfSeq));
  }

  const body = buildJsonl(records);
  const filename = `aomatsu_mondo_answers_${jstDateStamp()}.jsonl`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/jsonl; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
