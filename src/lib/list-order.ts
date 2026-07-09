// =============================================================================
// 質問のフィルタ＋並び替え（一覧 / 回答画面の前後移動で共有）
//   Stage 3a の一覧（src/app/page.tsx）と Stage 4 の回答画面（前後移動）が
//   「同じフィルタ・同じ並び」を再現するための単一の実装。二重実装を避けるため、
//   両者はここを呼ぶ（実装計画 Stage 4 制約）。
//
//   前提: 呼び出し側は questions を id 昇順で渡すこと（seededShuffle は入力順に
//   依存するため。'q1_001' 形式なので id 昇順 = カテゴリ順を兼ねる）。
// =============================================================================
import type { QuestionRow } from './types';
import type { QuestionUIStatus } from './question-status';
import { seededShuffle } from './shuffle';
import type { ListQuery } from './list-query';

/** ある質問の一覧上の状態を取り出す（マップ未登録は 'unanswered'）。 */
export function statusOf(
  statusMap: Record<string, QuestionUIStatus>,
  questionId: string,
): QuestionUIStatus {
  return statusMap[questionId] ?? 'unanswered';
}

/** カテゴリ・状態フィルタを適用する（並び替えはしない）。 */
export function filterQuestions(
  questions: readonly QuestionRow[],
  statusMap: Record<string, QuestionUIStatus>,
  query: ListQuery,
): QuestionRow[] {
  return questions
    .filter((q) => query.cat === 'all' || q.category === query.cat)
    .filter((q) => query.status === 'all' || statusOf(statusMap, q.id) === query.status);
}

/**
 * フィルタ＋並び替えを適用した質問配列を返す。
 *   category    = id昇順（入力が id 昇順である前提でそのまま）
 *   random      = seed 付き Fisher-Yates（seed 未指定は 0 扱い）
 *   draft_first = 下書きを先頭へ、残りは id 昇順
 * 一覧はこの配列をそのまま描画し、回答画面は現在 id の前後要素を隣接質問とする。
 */
export function orderQuestions(
  questions: readonly QuestionRow[],
  statusMap: Record<string, QuestionUIStatus>,
  query: ListQuery,
): QuestionRow[] {
  const filtered = filterQuestions(questions, statusMap, query);

  if (query.sort === 'random') {
    return seededShuffle(filtered, query.seed ?? 0);
  }
  if (query.sort === 'draft_first') {
    return [...filtered].sort((a, b) => {
      const aIsDraft = statusOf(statusMap, a.id) === 'draft' ? 0 : 1;
      const bIsDraft = statusOf(statusMap, b.id) === 'draft' ? 0 : 1;
      if (aIsDraft !== bIsDraft) return aIsDraft - bIsDraft;
      return a.id.localeCompare(b.id);
    });
  }
  return filtered; // category: 既に id 昇順
}

/** 隣接質問（前後）。フィルタで現在 id が並びから外れている場合は両方 null。 */
export interface Neighbors {
  prev: QuestionRow | null;
  next: QuestionRow | null;
}

/** 並び済み配列から現在 id の前後を求める。 */
export function findNeighbors(ordered: readonly QuestionRow[], currentId: string): Neighbors {
  const index = ordered.findIndex((q) => q.id === currentId);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: index > 0 ? ordered[index - 1] : null,
    next: index < ordered.length - 1 ? ordered[index + 1] : null,
  };
}
