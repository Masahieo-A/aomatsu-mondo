// =============================================================================
// 青松AI コーパスパイプライン  Fragment 共通スキーマ
//   全工程（01_extract → 02_anonymize → 03_tag → 04_integrate → 05_kernel_draft）
//   がこの型を受け渡す。要件: docs/requirements_aomatsu_ai.md 3.3
//     - text は「本人の声」のみ（AIの応答は学習対象にしない）
//     - 全断片が origin（出典ID）を保持し、後からコーパス→原典へ遡れること
// =============================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const FRAGMENT_SOURCES = [
  'app', // 青松問答の回答（思考層の正典）
  'claude', // AI対話ログ（Claude）
  'chatgpt', // AI対話ログ（ChatGPT）
  'gemini', // AI対話ログ（Gemini）
  'note', // 公開文章（Note）
  'x', // 公開文章（X）
  'work', // 業務文書（提案書・稟議・教材）
  'tensaku', // 添削差分（最重要の校正データ）
] as const;
export type FragmentSource = (typeof FRAGMENT_SOURCES)[number];

export type FragmentLayer = 'thinking' | 'style' | 'knowledge';
export type FragmentRegister = 'public' | 'private' | 'formal';

/**
 * コーパス素材の最小単位。
 * 正典の優先順位（要件3.2-1）: tensaku > app・note/x > claude/chatgpt/gemini。
 * 統合・草案工程はこの優先順位を source から判定する（sourcePriority を使用）。
 */
export interface Fragment {
  /** frg_<source>_<6桁連番>。01_extract が決定的に採番（同じ入力なら同じid） */
  id: string;
  source: FragmentSource;
  /** 03_tag で付与。app 由来はカテゴリから確定済み（CATEGORY_LAYER） */
  layer: FragmentLayer | null;
  /** 03_tag で付与（2〜5個の日本語キーワード） */
  topics: string[];
  register: FragmentRegister | null;
  /** 0〜1。この断片がどれだけ明瞭に本人の思考・文体を表すか（03のLLM評価） */
  confidence: number | null;
  /** 本人の声のみ。AI応答・引用元の他人の文章は含めない */
  text: string;
  /** 発話の文脈（AIログなら何に answering していたか等）。無ければ null */
  context: string | null;
  /** ISO8601。不明なら null */
  created_at: string | null;
  /** 出典ID: app:ans_0123 / chatgpt:<conv-id>#<idx> / claude:<uuid>#<idx> / texts:<file>#L<n> / tensaku:<file> */
  origin: string;
  /** 02_anonymize を通過済みか（04以降は true の断片のみ扱う） */
  anonymized: boolean;
}

/** 正典の優先順位（大きいほど優先。要件3.2-1。添削差分 > アプリ回答・公開文章 > AIログ） */
export function sourcePriority(source: FragmentSource): number {
  switch (source) {
    case 'tensaku':
      return 3;
    case 'app':
    case 'note':
    case 'x':
    case 'work':
      return 2;
    case 'claude':
    case 'chatgpt':
    case 'gemini':
      return 1;
  }
}

/** AI対話ログ由来か（3モデル交差検証の対象。要件3.2-2） */
export function isAiLogSource(source: FragmentSource): boolean {
  return source === 'claude' || source === 'chatgpt' || source === 'gemini';
}

export function fragmentId(source: FragmentSource, seq: number): string {
  return `frg_${source}_${String(seq).padStart(6, '0')}`;
}

// -----------------------------------------------------------------------------
// 検証
// -----------------------------------------------------------------------------
export type FragmentValidation =
  | { ok: true; fragment: Fragment }
  | { ok: false; errors: string[] };

export function validateFragment(obj: unknown): FragmentValidation {
  const errors: string[] = [];
  const f = obj as Partial<Fragment>;

  if (typeof f !== 'object' || f === null) return { ok: false, errors: ['not an object'] };
  if (typeof f.id !== 'string' || !/^frg_[a-z]+_\d{6}$/.test(f.id)) errors.push(`id 不正: ${f.id}`);
  if (!FRAGMENT_SOURCES.includes(f.source as FragmentSource)) errors.push(`source 不正: ${f.source}`);
  if (f.layer !== null && !['thinking', 'style', 'knowledge'].includes(f.layer as string))
    errors.push(`layer 不正: ${f.layer}`);
  if (!Array.isArray(f.topics)) errors.push('topics が配列でない');
  if (f.register !== null && !['public', 'private', 'formal'].includes(f.register as string))
    errors.push(`register 不正: ${f.register}`);
  if (f.confidence !== null && (typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1))
    errors.push(`confidence 不正: ${f.confidence}`);
  if (typeof f.text !== 'string' || f.text.trim().length === 0) errors.push('text が空');
  if (typeof f.origin !== 'string' || f.origin.length === 0) errors.push('origin が空');
  if (typeof f.anonymized !== 'boolean') errors.push('anonymized が boolean でない');

  return errors.length === 0 ? { ok: true, fragment: f as Fragment } : { ok: false, errors };
}

// -----------------------------------------------------------------------------
// JSONL 入出力（全工程共通のIOヘルパ）
// -----------------------------------------------------------------------------
export function readFragmentsJsonl(path: string): Fragment[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    const v = validateFragment(JSON.parse(line));
    if (!v.ok) throw new Error(`${path}:${i + 1} 不正なFragment: ${v.errors.join(', ')}`);
    return v.fragment;
  });
}

export function writeFragmentsJsonl(path: string, fragments: Fragment[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = fragments.map((f) => JSON.stringify(f)).join('\n');
  writeFileSync(path, body.length > 0 ? body + '\n' : '');
}

// -----------------------------------------------------------------------------
// パイプラインの標準パス（全スクリプトで共有）
// -----------------------------------------------------------------------------
export const PIPELINE_PATHS = {
  sources: 'pipeline/sources',
  ngWords: 'pipeline/private/ng-words.txt',
  raw: 'pipeline/work/fragments_raw.jsonl', // 01の出力
  anonymizeReport: 'pipeline/work/anonymize_report.md', // 02のレビューレポート
  clean: 'pipeline/work/fragments_clean.jsonl', // 02 --apply の出力
  tagged: 'pipeline/work/fragments_tagged.jsonl', // 03の出力（追記・再開式）
  materials: 'corpus/materials', // 04の出力先
  crossModelReport: 'corpus/materials/cross-model-report.md',
  kernel: 'corpus/kernel/persona-kernel.md',
  styleGuide: 'corpus/style-guide.md',
  kernelDraft: 'pipeline/work/kernel_draft.md', // 05の出力（本人レビュー用）
} as const;
