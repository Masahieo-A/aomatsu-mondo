// =============================================================================
// QuestionList : 質問一覧の単純リスト（仮想化なし・350件想定）
//   行全体がリンク。タップターゲット44px以上。質問文は2行で省略表示。
//   リンク先は現在のフィルタ文脈（cat/status/sort/seed）をそのまま引き継ぐ
//   （回答画面の前後移動が同じ文脈で隣接質問を決めるため）。
// =============================================================================
import Link from 'next/link';
import type { QuestionRow } from '@/lib/types';
import { formatQuestionId, type QuestionUIStatus } from '@/lib/question-status';
import { buildDetailQueryString, type ListQuery } from '@/lib/list-query';
import { StatusBadge } from './StatusBadge';

export function QuestionList({
  questions,
  statusMap,
  query,
}: {
  questions: readonly QuestionRow[];
  statusMap: Record<string, QuestionUIStatus>;
  query: ListQuery;
}) {
  if (questions.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-sm text-zinc-500">
        条件に一致する質問がありません
      </p>
    );
  }

  const detailQs = buildDetailQueryString(query);

  return (
    <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {questions.map((q) => {
        const status = statusMap[q.id] ?? 'unanswered';
        return (
          <li key={q.id}>
            <Link
              href={`/q/${q.id}${detailQs}`}
              className="flex min-h-[44px] items-center gap-3 px-4 py-3 transition active:bg-zinc-100 dark:active:bg-zinc-800"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-zinc-400 dark:text-zinc-500">
                  {formatQuestionId(q.id)}
                </p>
                <p className="line-clamp-2 text-sm text-zinc-800 dark:text-zinc-100">{q.body}</p>
              </div>
              <StatusBadge status={status} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
