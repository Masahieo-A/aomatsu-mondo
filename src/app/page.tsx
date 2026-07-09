// =============================================================================
// / : 質問一覧（コア画面, Stage 3a）
//   - getAllowedUser() で認証+ホワイトリスト確認（非許可はログアウトできないため /login へ）
//   - questions(status='approved') + 自分のanswers全行 + coverage を取得
//   - フィルタ(cat/status)・並び順(sort)・シード(seed)は全てURLクエリで表現する
//     （ブックマーク・リロード耐性。実装計画 Stage 3a 仕様）
//   - sort=random で seed 未指定の初回アクセス時は、ランダムseedを生成して
//     URLに付与しリダイレクトする（以降は同じseedを使い回し、同じ並びを保つ）
// =============================================================================
import { redirect } from 'next/navigation';
import { getAllowedUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import {
  type AnswerRow,
  type CoverageRow,
  type QuestionRow,
} from '@/lib/types';
import { buildQuestionStatusMap } from '@/lib/question-status';
import { generateRandomSeed } from '@/lib/shuffle';
import { orderQuestions } from '@/lib/list-order';
import { parseListQuery, type RawListSearchParams } from '@/lib/list-query';
import { Header } from '@/components/Header';
import { FilterBar } from '@/components/FilterBar';
import { QuestionList } from '@/components/QuestionList';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<RawListSearchParams>;
}) {
  const user = await getAllowedUser();
  if (!user) redirect('/login');

  const rawSp = await searchParams;
  const query = parseListQuery(rawSp);

  // sort=random だが seed 未指定 → ランダムseedを生成してURLへ付与しリダイレクト。
  // （回答画面から一覧へ戻ったときに並びが変わらないよう、seedをURLで固定する）
  if (query.sort === 'random' && query.seed === undefined) {
    const seed = generateRandomSeed();
    const params = new URLSearchParams();
    if (query.cat !== 'all') params.set('cat', query.cat);
    if (query.status !== 'all') params.set('status', query.status);
    params.set('sort', 'random');
    params.set('seed', String(seed));
    redirect(`/?${params.toString()}`);
  }

  const supabase = await createClient();

  const [questionsRes, answersRes, coverageRes] = await Promise.all([
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
    supabase.from('coverage').select('category, answered_count, draft_count, target_count'),
  ]);

  const questions: QuestionRow[] = questionsRes.data ?? [];
  const answers: AnswerRow[] = answersRes.data ?? [];
  const coverage: CoverageRow[] = coverageRes.data ?? [];

  const statusMap = buildQuestionStatusMap(answers);

  // フィルタ＋並び替えは回答画面の前後移動と共有する（src/lib/list-order.ts）。
  // 二重実装を避けるため両者は同じ関数・同じ seed を使い、同じ並びを再現する。
  const ordered = orderQuestions(questions, statusMap, query);

  return (
    <>
      <Header />
      <main className="flex flex-1 flex-col">
        <FilterBar query={query} coverage={coverage} />
        <QuestionList questions={ordered} statusMap={statusMap} query={query} />
      </main>
    </>
  );
}
