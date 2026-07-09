// =============================================================================
// 青松問答 v1.0  共通型・定数
// 後続ステージ（認証・一覧・回答UI・エクスポート）は全てここを参照する。
// DBスキーマは supabase/migrations/00001_init.sql と一致させること。
// =============================================================================

// -----------------------------------------------------------------------------
// カテゴリ
// -----------------------------------------------------------------------------
export const CATEGORIES = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'] as const;
export type Category = (typeof CATEGORIES)[number];

/** カテゴリ表示名（要件定義書 3.1） */
export const CATEGORY_LABELS: Record<Category, string> = {
  Q1: '価値観二択',
  Q2: '判断エピソード',
  Q3: '意見表明',
  Q4: '文体A/B',
  Q5: '日常・対人・感情',
  Q6: '美意識・好み',
  Q7: '事実・経歴',
};

/** カテゴリ別の初期目標問数（要件定義書 3.1 / coverage.target_count と一致） */
export const CATEGORY_TARGETS: Record<Category, number> = {
  Q1: 60,
  Q2: 50,
  Q3: 60,
  Q4: 40,
  Q5: 60,
  Q6: 40,
  Q7: 40,
};

/** A/B選択肢を持つカテゴリ（body_options / choice を使う） */
export const CHOICE_CATEGORIES: readonly Category[] = ['Q1', 'Q4'] as const;

/** 理由テキストが必須（最低20字）のカテゴリ（要件定義書 4.3） */
export const REASON_REQUIRED_CATEGORIES: readonly Category[] = ['Q1', 'Q4'] as const;

/** 理由テキストの最低文字数（Q1/Q4） */
export const REASON_MIN_LENGTH = 20;

// -----------------------------------------------------------------------------
// 層（layer）マッピング
//   エクスポート時の "layer" フィールドを導出する固定マッピング（計画の裁量判断）。
//   Q6 は「文体・思考層」の両層跨りだが、エクスポートは単一文字列のため文体層(style)を
//   優先する。コーパス統合側で category から再分類できるため情報損失はない。
// -----------------------------------------------------------------------------
export type Layer = 'thinking' | 'style' | 'knowledge';

export const CATEGORY_LAYER: Record<Category, Layer> = {
  Q1: 'thinking',
  Q2: 'thinking',
  Q3: 'thinking',
  Q4: 'style',
  Q5: 'thinking',
  Q6: 'style', // 文体・思考層の両層跨り。単一文字列のため style を優先（category から再分類可）
  Q7: 'knowledge',
};

// -----------------------------------------------------------------------------
// 列挙（DBの check 制約と一致）
// -----------------------------------------------------------------------------
export type QuestionSource = 'seed' | 'llm' | 'gap_detection';
export type QuestionStatus = 'draft' | 'approved' | 'rejected';

export type AnswerStatus = 'draft' | 'submitted';
export type InputMode = 'text' | 'voice_raw' | 'voice_edited';
export type Choice = 'A' | 'B';
export type SkipReason = '答えたくない' | '思いつかない' | '質問が悪い';

export const SKIP_REASONS: readonly SkipReason[] = [
  '答えたくない',
  '思いつかない',
  '質問が悪い',
] as const;

// -----------------------------------------------------------------------------
// A/B選択肢
// -----------------------------------------------------------------------------
export interface BodyOptions {
  A: string;
  B: string;
}

// -----------------------------------------------------------------------------
// DB行の型
// -----------------------------------------------------------------------------

/** questions テーブルの1行 */
export interface QuestionRow {
  id: string; // 'q1_001' 形式
  category: Category;
  body: string;
  body_options: BodyOptions | null; // Q1/Q4 のみ非null
  source: QuestionSource;
  status: QuestionStatus;
  reject_reason: string | null;
  reask_after: string | null; // date（'YYYY-MM-DD'）
  created_at: string; // timestamptz（ISO8601）
}

/** answers テーブルの1行 */
export interface AnswerRow {
  id: string; // uuid
  seq: number; // bigint identity（export id "ans_%04d" 用）
  question_id: string;
  user_id: string; // uuid
  status: AnswerStatus;
  answer_text: string | null;
  reason_text: string | null;
  choice: Choice | null;
  followup_q: string | null;
  followup_a: string | null;
  input_mode: InputMode;
  skipped: boolean;
  skip_reason: SkipReason | null;
  revision_of: string | null; // uuid（自己参照）
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

/** coverage view の1行 */
export interface CoverageRow {
  category: Category;
  answered_count: number;
  draft_count: number;
  target_count: number;
}

// -----------------------------------------------------------------------------
// seed / エクスポート補助型
// -----------------------------------------------------------------------------

/** seed/questions.json の1要素（投入前の最小形。source/status 等はDBデフォルト） */
export interface SeedQuestion {
  id: string;
  category: Category;
  body: string;
  body_options?: BodyOptions | null;
}

/** エクスポートJSONL 1行（要件定義書 4.6。キー順もこの順で出力する） */
export interface ExportRecord {
  id: string; // "ans_0123"
  category: Category;
  question: string;
  answer: string | null;
  reason: string | null;
  followup_q: string | null;
  followup_a: string | null;
  layer: Layer;
  topics: string[]; // v1.0 は常に []
  register: 'private'; // v1.0 は常に "private"
  input_mode: InputMode;
  answered_at: string; // submitted_at を JST(+09:00) 整形
  revision_of: string | null; // 参照先回答の同形式id or null
}
