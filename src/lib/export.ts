// =============================================================================
// 青松問答 v1.0  JSONLエクスポート変換ロジック
//   要件定義書 4.6（エクスポート仕様）に厳密準拠。DBアクセスを含まない純粋関数のみを
//   ここに置き、実際のDB取得・レスポンス生成は src/app/api/export/route.ts が担う
//   （テスト容易性のため。計画「JSONLエクスポート」節と同じ分離方針）。
// =============================================================================
import { CATEGORY_LAYER, type AnswerRow, type ExportRecord, type QuestionRow } from './types';

// -----------------------------------------------------------------------------
// id 変換: "ans_" + seq を最低4桁ゼロ埋め（5桁以上はそのまま桁が増える）
//   例: 123 → "ans_0123" / 7 → "ans_0007" / 12345 → "ans_12345"
// -----------------------------------------------------------------------------
export function formatAnswerId(seq: number): string {
  return `ans_${String(seq).padStart(4, '0')}`;
}

// -----------------------------------------------------------------------------
// JST(+09:00) ISO8601整形（ミリ秒なし、必ず +09:00 表記）
//   タイムゾーンに依存しない実装: UTCエポックに+9hしてから UTC getter で組み立てる
//   （実行環境のローカルタイムゾーン設定に左右されない）。
// -----------------------------------------------------------------------------
export function toJstIso(utcIso: string): string {
  const utcMs = new Date(utcIso).getTime();
  const jst = new Date(utcMs + 9 * 60 * 60 * 1000);

  const pad = (n: number): string => String(n).padStart(2, '0');

  const yyyy = jst.getUTCFullYear();
  const mm = pad(jst.getUTCMonth() + 1);
  const dd = pad(jst.getUTCDate());
  const hh = pad(jst.getUTCHours());
  const mi = pad(jst.getUTCMinutes());
  const ss = pad(jst.getUTCSeconds());

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+09:00`;
}

/**
 * JST基準の "YYYYMMDD" 日付スタンプ（エクスポートファイル名用）。
 * toJstIso と同じ「UTCエポック+9h → UTC getter」方式でタイムゾーン非依存にする。
 */
export function jstDateStamp(date: Date = new Date()): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}`;
}

// -----------------------------------------------------------------------------
// answers 1行 + questions 1行 → ExportRecord 1件への変換
//   revisionOfSeq: revision_of が指す参照先回答の seq（参照なしは null）。
//   呼び出し側（route.ts）が answers 全行の id→seq マップから解決して渡す。
// -----------------------------------------------------------------------------
export function toExportRecord(
  answer: AnswerRow,
  question: QuestionRow,
  revisionOfSeq: number | null,
): ExportRecord {
  if (!answer.submitted_at) {
    // エクスポート対象は status='submitted' の行のみのはずで、submitted_at が
    // 無いのはデータ不整合。呼び出し側のフィルタ漏れを早期に検出するため例外にする。
    throw new Error(`toExportRecord: submitted_at が null です (answer.id=${answer.id})`);
  }

  // 選択式（Q1/Q4）は answer_text ではなく choice に結論が入る。要件定義書4.6の
  // フィールド一覧に choice が無いため、answer に「A: 選択肢本文」形式で書き出す
  // （"A" だけでは body_options 無しに意味が取れず、コーパスとして結論が欠落するため）。
  const choiceText =
    answer.choice && question.body_options
      ? `${answer.choice}: ${question.body_options[answer.choice]}`
      : answer.choice;

  return {
    id: formatAnswerId(answer.seq),
    category: question.category,
    question: question.body,
    answer: answer.answer_text ?? choiceText ?? null,
    reason: answer.reason_text,
    followup_q: answer.followup_q,
    followup_a: answer.followup_a,
    layer: CATEGORY_LAYER[question.category],
    topics: [], // v1.0はLLMタグ付け無しのため常に空配列（v1.1で充填）
    register: 'private', // v1.0は本人の私的回答のみのため固定
    input_mode: answer.input_mode,
    answered_at: toJstIso(answer.submitted_at),
    revision_of: revisionOfSeq !== null ? formatAnswerId(revisionOfSeq) : null,
  };
}

// -----------------------------------------------------------------------------
// ExportRecord[] → JSONL文字列
//   1行1JSON+改行。キー順は要件定義書4.6の例と同一になるよう明示的に固定する
//   （JSON.stringifyの出力順に依存しない）。
// -----------------------------------------------------------------------------
const EXPORT_KEY_ORDER: readonly (keyof ExportRecord)[] = [
  'id',
  'category',
  'question',
  'answer',
  'reason',
  'followup_q',
  'followup_a',
  'layer',
  'topics',
  'register',
  'input_mode',
  'answered_at',
  'revision_of',
];

function toOrderedPlainObject(record: ExportRecord): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of EXPORT_KEY_ORDER) {
    ordered[key] = record[key];
  }
  return ordered;
}

export function buildJsonl(records: ExportRecord[]): string {
  if (records.length === 0) return '';
  return records.map((r) => JSON.stringify(toOrderedPlainObject(r))).join('\n') + '\n';
}
