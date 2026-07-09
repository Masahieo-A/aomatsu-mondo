// =============================================================================
// 青松問答 v1.0  回答操作ライブラリ
//   要件定義書 4.2（途中保存）/ 4.3（回答UI）/ 5（データモデル）準拠。
//
//   Supabase クライアントに直接依存させず、最小インターフェース AnswersRepo を注入
//   する設計。純粋なドメインロジック（draft upsert / submit / skip / revise / 検証）を
//   テスト可能にし、実 DB アクセスはアダプタ（createSupabaseAnswersRepo）に閉じ込める。
//
//   下書きの一意性は DB の部分ユニークインデックス answers_one_draft_per_question
//   （status='draft' の行は質問ごとに1つ）で担保。部分ユニークは upsert の onConflict に
//   使えないため、「draft 行を select → あれば update / なければ insert」の2段階で行う。
//   シングルユーザーのため競合リスクは実質ない（計画の判断）。
// =============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CHOICE_CATEGORIES,
  REASON_MIN_LENGTH,
  REASON_REQUIRED_CATEGORIES,
  type AnswerRow,
  type AnswerStatus,
  type Category,
  type Choice,
  type SkipReason,
} from './types';

// -----------------------------------------------------------------------------
// 入出力の型
// -----------------------------------------------------------------------------

/** 回答本文の入力（回答画面から渡ってくる編集可能フィールド） */
export interface AnswerInput {
  answer_text?: string | null;
  reason_text?: string | null;
  choice?: Choice | null;
}

/** answers への insert に必要な最小フィールド（user_id は DB が auth.uid() で補完） */
export interface NewAnswer {
  question_id: string;
  status: AnswerStatus;
  answer_text?: string | null;
  reason_text?: string | null;
  choice?: Choice | null;
  skipped?: boolean;
  skip_reason?: SkipReason | null;
  revision_of?: string | null;
  submitted_at?: string | null;
}

/** answers の update パッチ（更新可能なカラムのみ。id/seq/user_id/created_at は不変） */
export type AnswerPatch = Partial<
  Pick<
    AnswerRow,
    | 'answer_text'
    | 'reason_text'
    | 'choice'
    | 'status'
    | 'skipped'
    | 'skip_reason'
    | 'revision_of'
    | 'submitted_at'
  >
>;

/** Supabase を抽象化した最小リポジトリ。テストではモックを注入する。 */
export interface AnswersRepo {
  /** 質問の draft 行（存在すれば1件）を返す */
  findDraft(questionId: string): Promise<AnswerRow | null>;
  /**
   * 質問の（再回答でもスキップでもない）最新の submitted 行を返す。編集対象の特定に使う。
   * スキップ行（skipped=true）を返してはならない: 返すと submitAnswer の編集パスが
   * スキップ行に回答を書き込み、skipped=true のままエクスポートから漏れてしまう。
   */
  findSubmitted(questionId: string): Promise<AnswerRow | null>;
  insert(row: NewAnswer): Promise<AnswerRow>;
  update(id: string, patch: AnswerPatch): Promise<AnswerRow>;
}

/** バリデーション結果 */
export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/** 書き込み系関数（submit / revise）の結果 */
export type WriteResult =
  | { ok: true; answer: AnswerRow }
  | { ok: false; errors: string[] };

// -----------------------------------------------------------------------------
// 内部ヘルパ
// -----------------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

/** 入力に含まれるキーだけを patch にする（未指定フィールドを null 上書きしない） */
function contentPatch(input: AnswerInput): AnswerPatch {
  const patch: AnswerPatch = {};
  if ('answer_text' in input) patch.answer_text = input.answer_text ?? null;
  if ('reason_text' in input) patch.reason_text = input.reason_text ?? null;
  if ('choice' in input) patch.choice = input.choice ?? null;
  return patch;
}

/** 文字数カウント（サロゲートペアを1文字として数えるため code point 単位） */
function charLength(text: string | null | undefined): number {
  return text ? Array.from(text.trim()).length : 0;
}

// -----------------------------------------------------------------------------
// バリデーション（クライアント / サーバー両方から使う共有関数）
//   要件定義書 4.3:
//     - Q1/Q4: A/B 選択必須 + 理由テキスト必須（最低 REASON_MIN_LENGTH 字）
//     - その他: 自由記述（answer_text 非空）
// -----------------------------------------------------------------------------
export function validateAnswer(category: Category, input: AnswerInput): ValidationResult {
  const errors: string[] = [];

  if (CHOICE_CATEGORIES.includes(category)) {
    if (input.choice !== 'A' && input.choice !== 'B') {
      errors.push('選択肢（A / B）を選んでください');
    }
  }

  if (REASON_REQUIRED_CATEGORIES.includes(category)) {
    if (charLength(input.reason_text) < REASON_MIN_LENGTH) {
      errors.push(`理由は${REASON_MIN_LENGTH}字以上で入力してください`);
    }
  } else {
    // 自由記述カテゴリ（Q2/Q3/Q5/Q6/Q7）は本文が非空であること
    if (charLength(input.answer_text) === 0) {
      errors.push('回答を入力してください');
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// -----------------------------------------------------------------------------
// 途中保存: draft 行への upsert
// -----------------------------------------------------------------------------
/**
 * 下書きを保存する。draft 行があれば更新、なければ新規 insert。
 * autosave.ts の save コールバックから呼ばれる中核。バリデーションはしない
 * （書きかけを常に保存できることが最優先。検証は送信時に行う）。
 */
export async function saveDraft(
  repo: AnswersRepo,
  questionId: string,
  input: AnswerInput,
): Promise<AnswerRow> {
  const draft = await repo.findDraft(questionId);
  if (draft) {
    return repo.update(draft.id, contentPatch(input));
  }
  return repo.insert({
    question_id: questionId,
    status: 'draft',
    ...contentPatch(input),
  });
}

// -----------------------------------------------------------------------------
// 送信: draft → submitted（または既存 submitted の編集）
//   category はバリデーションに必要なため引数に追加している（要件 4.3）。
// -----------------------------------------------------------------------------
/**
 * 回答を確定する。
 *   1. draft があれば status='submitted' + submitted_at=now に更新
 *   2. draft が無く既存 submitted があれば「編集」としてその行を更新
 *      （submitted_at は変えない。updated_at は DB トリガー任せ）
 *   3. どちらも無ければ submitted 行を新規 insert
 */
export async function submitAnswer(
  repo: AnswersRepo,
  questionId: string,
  input: AnswerInput,
  category: Category,
): Promise<WriteResult> {
  const validation = validateAnswer(category, input);
  if (!validation.ok) return validation;

  const draft = await repo.findDraft(questionId);
  if (draft) {
    const answer = await repo.update(draft.id, {
      ...contentPatch(input),
      status: 'submitted',
      submitted_at: nowIso(),
      skipped: false, // 下書きを本回答として確定するのでスキップ扱いは解除
    });
    return { ok: true, answer };
  }

  const existing = await repo.findSubmitted(questionId);
  if (existing) {
    // 既存の確定回答の編集。submitted_at は初回確定時のまま保持する。
    const answer = await repo.update(existing.id, contentPatch(input));
    return { ok: true, answer };
  }

  const answer = await repo.insert({
    question_id: questionId,
    status: 'submitted',
    submitted_at: nowIso(),
    ...contentPatch(input),
  });
  return { ok: true, answer };
}

// -----------------------------------------------------------------------------
// スキップ
// -----------------------------------------------------------------------------
/**
 * 質問をスキップする。skipped=true + skip_reason + status='submitted' で保存。
 * 書きかけの draft 行があればそれを転用する（1質問1アクティブ行を保つため）。
 * skip_reason は質問バンク改善用に DB に残る（エクスポートからは除外＝計画の判断）。
 */
export async function skipQuestion(
  repo: AnswersRepo,
  questionId: string,
  reason: SkipReason,
): Promise<AnswerRow> {
  const patch: AnswerPatch = {
    skipped: true,
    skip_reason: reason,
    status: 'submitted',
    submitted_at: nowIso(),
  };

  const draft = await repo.findDraft(questionId);
  if (draft) {
    return repo.update(draft.id, patch);
  }
  return repo.insert({
    question_id: questionId,
    status: 'submitted',
    skipped: true,
    skip_reason: reason,
    submitted_at: patch.submitted_at ?? nowIso(),
  });
}

// -----------------------------------------------------------------------------
// 再回答（Q1/Q3 の6ヶ月後）
//   v1.0 では UI 非公開だが、ロジックとテストは用意する（計画・指示 3）。
// -----------------------------------------------------------------------------
/**
 * 再回答を作成する。revision_of=previousAnswerId を持つ「新しい」submitted 行を
 * insert する。旧行は一切変更しない（意見の時間変化を両方残すのがコーパス価値）。
 */
export async function reviseAnswer(
  repo: AnswersRepo,
  questionId: string,
  previousAnswerId: string,
  input: AnswerInput,
  category: Category,
): Promise<WriteResult> {
  const validation = validateAnswer(category, input);
  if (!validation.ok) return validation;

  const answer = await repo.insert({
    question_id: questionId,
    status: 'submitted',
    submitted_at: nowIso(),
    revision_of: previousAnswerId,
    ...contentPatch(input),
  });
  return { ok: true, answer };
}

/** 半年（6ヶ月）を表す定数（要件定義書 4.1: Q1・Q3 は6ヶ月経過後に再回答可） */
export const REASK_MONTHS = 6;

/**
 * 前回確定から再回答可能な期間（6ヶ月）が経過したか判定する。
 * @param submittedAt 前回確定日時（ISO8601 文字列）
 * @param now         判定基準の現在時刻
 */
export function canReask(submittedAt: string, now: Date): boolean {
  const from = new Date(submittedAt);
  const threshold = new Date(from);
  threshold.setMonth(threshold.getMonth() + REASK_MONTHS);
  return now.getTime() >= threshold.getTime();
}

// -----------------------------------------------------------------------------
// 実クライアント用アダプタ
//   部分ユニークインデックスは onConflict upsert に使えないため、findDraft →
//   update / insert の2段階で書く（saveDraft / submitAnswer / skipQuestion が担当）。
// -----------------------------------------------------------------------------
export function createSupabaseAnswersRepo(supabase: SupabaseClient): AnswersRepo {
  const table = () => supabase.from('answers');

  return {
    async findDraft(questionId) {
      const { data, error } = await table()
        .select('*')
        .eq('question_id', questionId)
        .eq('status', 'draft')
        .maybeSingle();
      if (error) throw error;
      return (data as AnswerRow | null) ?? null;
    },

    async findSubmitted(questionId) {
      // 再回答（revision_of が非 null）でもスキップでもない最新の確定回答を編集対象とする。
      // スキップ行を除外しないと、スキップ済み質問への直接送信がスキップ行を「編集」して
      // skipped=true のまま回答が保存され、エクスポート対象から漏れる。
      const { data, error } = await table()
        .select('*')
        .eq('question_id', questionId)
        .eq('status', 'submitted')
        .eq('skipped', false)
        .is('revision_of', null)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as AnswerRow | null) ?? null;
    },

    async insert(row) {
      const { data, error } = await table().insert(row).select('*').single();
      if (error) throw error;
      return data as AnswerRow;
    },

    async update(id, patch) {
      const { data, error } = await table()
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data as AnswerRow;
    },
  };
}
