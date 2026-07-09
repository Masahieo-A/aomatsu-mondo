// =============================================================================
// /q/[id] : 回答画面（Stage 4。3a 一覧 + 3b 自動保存コアの統合）
//   サーバー側の責務:
//     - getAllowedUser() で認証+ホワイトリスト確認（非許可は /login へ）
//     - approved 質問全件 + 自分の answers 全行を取得
//     - URLクエリ(cat/status/sort/seed)を parseListQuery で読み、一覧と同一の
//       フィルタ・並び（src/lib/list-order.ts）を再現して現在 id の前後を求める
//     - 現在質問の draft 行（下書き完全復元）/ 最新 submitted 行（編集モード）/
//       skip 行を判定し、初期値と初期モードをクライアントへ注入する
//
//   注意（仕様として許容）: status フィルタ中に回答すると次回レンダリングで並びから
//   消えるため前後が変わり得る。一覧に戻れば整合するため許容する（指示どおり）。
// =============================================================================
import { notFound, redirect } from 'next/navigation';

import { getAllowedUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import {
  CHOICE_CATEGORIES,
  type AnswerRow,
  type Choice,
  type QuestionRow,
  type SkipReason,
} from '@/lib/types';
import { buildQuestionStatusMap } from '@/lib/question-status';
import { generateRandomSeed } from '@/lib/shuffle';
import { orderQuestions, findNeighbors } from '@/lib/list-order';
import {
  parseListQuery,
  buildDetailQueryString,
  type RawListSearchParams,
} from '@/lib/list-query';
import { Header } from '@/components/Header';
import { AnswerForm } from '@/components/AnswerForm';

export default async function AnswerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawListSearchParams>;
}) {
  const user = await getAllowedUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const rawSp = await searchParams;
  const query = parseListQuery(rawSp);

  // 一覧と同じく、sort=random で seed 未指定なら生成して付与しリダイレクト
  // （前後移動の並びを一覧と一致させるため）。
  if (query.sort === 'random' && query.seed === undefined) {
    const seed = generateRandomSeed();
    const params2 = new URLSearchParams();
    if (query.cat !== 'all') params2.set('cat', query.cat);
    if (query.status !== 'all') params2.set('status', query.status);
    params2.set('sort', 'random');
    params2.set('seed', String(seed));
    redirect(`/q/${id}?${params2.toString()}`);
  }

  const supabase = await createClient();

  const [questionsRes, answersRes] = await Promise.all([
    supabase
      .from('questions')
      .select('id, category, body, body_options, source, status, reject_reason, reask_after, created_at')
      .eq('status', 'approved')
      .order('id', { ascending: true }),
    supabase
      .from('answers')
      .select(
        'id, seq, question_id, user_id, status, answer_text, reason_text, choice, followup_q, followup_a, input_mode, skipped, skip_reason, revision_of, created_at, updated_at, submitted_at',
      )
      .eq('user_id', user.id),
  ]);

  const questions: QuestionRow[] = questionsRes.data ?? [];
  const answers: AnswerRow[] = answersRes.data ?? [];

  const question = questions.find((q) => q.id === id);
  if (!question) notFound();

  // 前後質問: 一覧と同一のフィルタ・並びを再現し、現在 id の隣接を取る。
  const statusMap = buildQuestionStatusMap(answers);
  const ordered = orderQuestions(questions, statusMap, query);
  const { prev, next } = findNeighbors(ordered, id);

  const detailQs = buildDetailQueryString(query);
  const prevHref = prev ? `/q/${prev.id}${detailQs}` : null;
  const nextHref = next ? `/q/${next.id}${detailQs}` : null;
  const listHref = `/${detailQs}`;

  // 現在質問の answers 行から初期値・初期モードを決める。
  const mine = answers.filter((a) => a.question_id === id);
  const draft = mine.find((a) => a.status === 'draft') ?? null;
  const submitted = mine
    .filter((a) => a.status === 'submitted' && !a.skipped && a.revision_of === null)
    .sort((a, b) => (b.submitted_at ?? '').localeCompare(a.submitted_at ?? ''))[0] ?? null;
  const skipRow = mine
    .filter((a) => a.status === 'submitted' && a.skipped)
    .sort((a, b) => (b.submitted_at ?? '').localeCompare(a.submitted_at ?? ''))[0] ?? null;

  // 優先順位: draft（下書き復元） > submitted（編集モード） > skip（スキップ表示） > 空（新規）
  let initialMode: 'answering' | 'submitted' | 'skipped';
  let source: AnswerRow | null;
  let skipReason: SkipReason | null = null;

  if (draft) {
    initialMode = 'answering';
    source = draft;
  } else if (submitted) {
    initialMode = 'submitted';
    source = submitted;
  } else if (skipRow) {
    initialMode = 'skipped';
    source = null;
    skipReason = skipRow.skip_reason;
  } else {
    initialMode = 'answering';
    source = null;
  }

  const isChoice = CHOICE_CATEGORIES.includes(question.category);
  const initialChoice: Choice | null = isChoice ? source?.choice ?? null : null;

  return (
    <>
      <Header />
      {/* key必須: 前後移動は同一ルート内遷移のため、key が無いと React が state
          （入力内容・mode・旧 questionId を閉包に持つ autosaver）を引き継いでしまい、
          次の質問の入力が前の質問の下書きへ保存されるデータ破損が起きる。 */}
      <AnswerForm
        key={question.id}
        questionId={question.id}
        category={question.category}
        body={question.body}
        bodyOptions={question.body_options}
        initialAnswerText={source?.answer_text ?? ''}
        initialReasonText={source?.reason_text ?? ''}
        initialChoice={initialChoice}
        initialMode={initialMode}
        skipReason={skipReason}
        prevHref={prevHref}
        nextHref={nextHref}
        listHref={listHref}
      />
    </>
  );
}
