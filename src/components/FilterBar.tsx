// =============================================================================
// FilterBar : カテゴリタブ + 状態フィルタ/並び順チップ
//   全てURLクエリへのリンク（Server Component、クライアントJS不要）。
//   カテゴリタブには表示名 + カバレッジ「回答済み/目標」のミニ数字を添える。
//   タップターゲットは44px以上（要件のモバイル操作性）。
// =============================================================================
import Link from 'next/link';
import { CATEGORIES, CATEGORY_LABELS, CATEGORY_TARGETS, type CoverageRow } from '@/lib/types';
import {
  buildListHref,
  STATUS_FILTERS,
  SORT_ORDERS,
  type ListQuery,
  type StatusFilter,
  type SortOrder,
} from '@/lib/list-query';
import { QUESTION_STATUS_LABELS } from '@/lib/question-status';

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: 'すべて',
  ...QUESTION_STATUS_LABELS,
};

const SORT_LABELS: Record<SortOrder, string> = {
  category: 'カテゴリ順',
  random: 'ランダム',
  draft_first: '下書き優先',
};

export function FilterBar({
  query,
  coverage,
}: {
  query: ListQuery;
  coverage: readonly CoverageRow[];
}) {
  const coverageByCategory = new Map(coverage.map((c) => [c.category, c]));
  const totalAnswered = CATEGORIES.reduce(
    (sum, cat) => sum + (coverageByCategory.get(cat)?.answered_count ?? 0),
    0,
  );
  const totalTarget = CATEGORIES.reduce(
    (sum, cat) => sum + (coverageByCategory.get(cat)?.target_count ?? CATEGORY_TARGETS[cat]),
    0,
  );

  return (
    <div className="border-b border-zinc-200 bg-[var(--background)] dark:border-zinc-800">
      <nav
        aria-label="カテゴリ"
        className="flex gap-1.5 overflow-x-auto px-3 py-2"
      >
        <Link href={buildListHref(query, { cat: 'all' })} className={tabClass(query.cat === 'all')}>
          <span>全</span>
          <span className="text-[10px] opacity-70">
            {totalAnswered}/{totalTarget}
          </span>
        </Link>
        {CATEGORIES.map((cat) => {
          const row = coverageByCategory.get(cat);
          const answered = row?.answered_count ?? 0;
          const target = row?.target_count ?? CATEGORY_TARGETS[cat];
          return (
            <Link
              key={cat}
              href={buildListHref(query, { cat })}
              className={tabClass(query.cat === cat)}
            >
              <span>{CATEGORY_LABELS[cat]}</span>
              <span className="text-[10px] opacity-70">
                {answered}/{target}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-2 px-3 pb-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="状態フィルタ">
          {STATUS_FILTERS.map((value) => (
            <Link
              key={value}
              href={buildListHref(query, { status: value })}
              className={chipClass(query.status === value)}
            >
              {STATUS_LABELS[value]}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="並び順">
          {SORT_ORDERS.map((value) => (
            <Link
              key={value}
              href={buildListHref(query, { sort: value })}
              className={chipClass(query.sort === value)}
            >
              {SORT_LABELS[value]}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function tabClass(active: boolean): string {
  return `flex min-h-11 shrink-0 flex-col items-center justify-center whitespace-nowrap rounded-lg px-3 py-1 text-xs font-medium transition ${
    active
      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
      : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
  }`;
}

function chipClass(active: boolean): string {
  return `inline-flex min-h-11 items-center rounded-full px-3 py-1 text-xs font-medium transition ${
    active
      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
      : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
  }`;
}
