// =============================================================================
// StatusBadge : 質問一覧の状態バッジ
//   未回答=グレー / 下書き=黄色系(目立たせる) / 回答済み=緑 / スキップ=薄グレー
//   （実装計画・要件定義書 4.1 のバッジ仕様）
// =============================================================================
import { QUESTION_STATUS_LABELS, type QuestionUIStatus } from '@/lib/question-status';

const STYLES: Record<QuestionUIStatus, string> = {
  unanswered: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  draft:
    'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:ring-amber-700',
  answered: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  skipped: 'bg-zinc-50 text-zinc-400 dark:bg-zinc-900/60 dark:text-zinc-600',
};

export function StatusBadge({ status }: { status: QuestionUIStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ${STYLES[status]}`}
    >
      {QUESTION_STATUS_LABELS[status]}
    </span>
  );
}
