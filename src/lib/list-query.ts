// =============================================================================
// 質問一覧のURLクエリパラメータ（フィルタ・並び順）
//   ブックマーク・リロード耐性のため、フィルタ状態は全てURLクエリで表現する
//   （実装計画 Stage 3a 仕様）。一覧ページ・FilterBar・QuestionList・
//   （将来のStage 4回答画面の前後移動）で共有する型とヘルパー。
// =============================================================================
import { CATEGORIES, type Category } from './types';
import { QUESTION_UI_STATUSES, type QuestionUIStatus } from './question-status';

export type CategoryFilter = 'all' | Category;
export type StatusFilter = 'all' | QuestionUIStatus;
export type SortOrder = 'category' | 'random' | 'draft_first';

export const STATUS_FILTERS: readonly StatusFilter[] = ['all', ...QUESTION_UI_STATUSES];
export const SORT_ORDERS: readonly SortOrder[] = ['category', 'random', 'draft_first'];

export interface ListQuery {
  cat: CategoryFilter;
  status: StatusFilter;
  sort: SortOrder;
  /** sort=random 時のシャッフルseed。それ以外は undefined。 */
  seed?: number;
}

export interface RawListSearchParams {
  cat?: string;
  status?: string;
  sort?: string;
  seed?: string;
}

/** URL検索パラメータ（文字列）を検証済みの ListQuery に変換する。不正値はデフォルトへフォールバック。 */
export function parseListQuery(sp: RawListSearchParams): ListQuery {
  const cat: CategoryFilter =
    sp.cat && (CATEGORIES as readonly string[]).includes(sp.cat) ? (sp.cat as Category) : 'all';

  const status: StatusFilter =
    sp.status && (STATUS_FILTERS as readonly string[]).includes(sp.status)
      ? (sp.status as StatusFilter)
      : 'all';

  const sort: SortOrder =
    sp.sort && (SORT_ORDERS as readonly string[]).includes(sp.sort) ? (sp.sort as SortOrder) : 'category';

  const seedNum = sp.seed !== undefined && sp.seed !== '' ? Number(sp.seed) : NaN;
  const seed = Number.isFinite(seedNum) ? seedNum : undefined;

  return { cat, status, sort, seed };
}

/**
 * 現在のクエリに部分的な変更を加えた「/」へのリンク文字列を組み立てる
 * （カテゴリタブ・状態フィルタ・並び順チップ用）。
 */
export function buildListHref(base: ListQuery, overrides: Partial<ListQuery>): string {
  const next: ListQuery = { ...base, ...overrides };

  // sort=random 以外なら seed は不要。
  // sort を「今回」明示的に random へ切り替えた場合は seed を落とし、
  // page.tsx 側で新しいランダムseedを生成させる。
  // （既にrandomのままカテゴリ/状態だけ変える場合はseedを維持し、同じ並びを保つ）
  let seed = next.seed;
  if (next.sort !== 'random') {
    seed = undefined;
  } else if (overrides.sort === 'random' && base.sort !== 'random') {
    seed = undefined;
  }

  return `/${queryStringOf({ ...next, seed })}`;
}

/** 質問詳細画面（/q/[id]）へ現在のフィルタ文脈をそのまま引き継ぐためのクエリ文字列。 */
export function buildDetailQueryString(query: ListQuery): string {
  return queryStringOf(query);
}

function queryStringOf(query: ListQuery): string {
  const params = new URLSearchParams();
  if (query.cat !== 'all') params.set('cat', query.cat);
  if (query.status !== 'all') params.set('status', query.status);
  if (query.sort !== 'category') params.set('sort', query.sort);
  if (query.seed !== undefined) params.set('seed', String(query.seed));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
