// =============================================================================
// 質問一覧の状態導出（Stage 3a）
//   1質問に紐づく answers 行（複数あり得る: draft/submitted 混在や再回答の旧行など）
//   から、一覧に表示する単一の状態を導出する純粋関数群。
//   Stage 4（回答画面）でも同じ判定を使う想定のため、ここから import すること。
// =============================================================================
import type { AnswerRow } from './types';

/** 一覧表示用の質問状態（要件定義書 4.1 / 実装計画のバッジ仕様） */
export type QuestionUIStatus = 'unanswered' | 'draft' | 'answered' | 'skipped';

export const QUESTION_UI_STATUSES: readonly QuestionUIStatus[] = [
  'unanswered',
  'draft',
  'answered',
  'skipped',
] as const;

/** 状態バッジの表示ラベル */
export const QUESTION_STATUS_LABELS: Record<QuestionUIStatus, string> = {
  unanswered: '未回答',
  draft: '下書き',
  answered: '回答済み',
  skipped: 'スキップ',
};

type AnswerStatusFields = Pick<AnswerRow, 'status' | 'skipped'>;
type AnswerForStatusMap = Pick<AnswerRow, 'question_id' | 'status' | 'skipped'>;

/**
 * 1質問分の answers 行から一覧の状態を導出する。優先順位（指示どおり）:
 *   1. draft 行が存在            → 'draft'（下書き）
 *   2. submitted かつ skipped=false が存在 → 'answered'（回答済み）
 *   3. submitted かつ skipped=true が存在  → 'skipped'（スキップ）
 *   4. いずれもなし               → 'unanswered'（未回答）
 */
export function deriveQuestionStatus(answers: readonly AnswerStatusFields[]): QuestionUIStatus {
  if (answers.some((a) => a.status === 'draft')) return 'draft';
  if (answers.some((a) => a.status === 'submitted' && !a.skipped)) return 'answered';
  if (answers.some((a) => a.status === 'submitted' && a.skipped)) return 'skipped';
  return 'unanswered';
}

/**
 * ユーザーの answers 全行から `question_id -> 状態` のマップを組み立てる。
 * 一覧（page.tsx）はこのマップを1回作り、各質問の描画・フィルタ・並び替えで使い回す。
 * マップに存在しない question_id は 'unanswered' として扱うこと（呼び出し側の責務）。
 */
export function buildQuestionStatusMap(
  answers: readonly AnswerForStatusMap[],
): Record<string, QuestionUIStatus> {
  const byQuestion = new Map<string, AnswerStatusFields[]>();
  for (const a of answers) {
    const list = byQuestion.get(a.question_id);
    if (list) {
      list.push(a);
    } else {
      byQuestion.set(a.question_id, [a]);
    }
  }

  const result: Record<string, QuestionUIStatus> = {};
  for (const [questionId, list] of byQuestion) {
    result[questionId] = deriveQuestionStatus(list);
  }
  return result;
}

/** 質問id 'q2_013' 形式 を表示用 'Q2-013' 形式に整形する。 */
export function formatQuestionId(id: string): string {
  const [catPart, ...rest] = id.split('_');
  if (rest.length === 0) return id;
  return `${catPart.toUpperCase()}-${rest.join('_')}`;
}
