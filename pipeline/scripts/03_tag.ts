// =============================================================================
// 03_tag  —  LLMによる断片タグ付け
//
//   入力: PIPELINE_PATHS.clean（02通過済みのみ。無ければ「先に02を実行」エラー）
//   出力: PIPELINE_PATHS.tagged（追記式。中断再開のため処理済みidはスキップ）
//   モデル: 既定 claude-sonnet-5（バルク向け）
//
//   CLI: npx tsx pipeline/scripts/03_tag.ts [--model <id>] [--batch-size 20]
//
//   要点:
//   - app 由来の layer は既存値を優先（LLM出力で上書きしない）
//   - topics に「要匿名化再確認」を含む断片は stderr に警告一覧を出す
//   - 応答パース失敗時: そのバッチを1回リトライ→なお失敗ならバッチ内idを
//     untagged としてstderrに出し、全体は止めず継続
// =============================================================================
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  PIPELINE_PATHS,
  readFragmentsJsonl,
  type Fragment,
  type FragmentLayer,
  type FragmentRegister,
} from '../lib/fragment';
import { TAGGING_SYSTEM_PROMPT, buildTaggingUserPrompt } from '../lib/prompts';
import { createClaudeClient, type ClaudeClient } from '../lib/claude-api';
import { createGeminiClient } from '../lib/gemini-api';

const DEFAULT_MODEL = 'claude-sonnet-5';

export type Provider = 'gemini' | 'claude';
/** 既定はGemini（無料枠で回せる。--provider claude で切替可） */
export const DEFAULT_PROVIDER: Provider = 'gemini';
export const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  gemini: 'gemini-3.5-flash', // 無料枠対象のバルク向けモデル
  claude: DEFAULT_MODEL,
};
const DEFAULT_BATCH_SIZE = 20;
// タグ付けはJSON配列を返すだけなので出力は小さい。バッチ20件でも十分収まる。
const TAG_MAX_TOKENS = 8000;
const REANONYMIZE_TOPIC = '要匿名化再確認';

// -----------------------------------------------------------------------------
// LLM応答1件分
// -----------------------------------------------------------------------------
interface TagItem {
  id: string;
  layer?: unknown;
  topics?: unknown;
  register?: unknown;
  confidence?: unknown;
}

export interface Logger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface RunTaggingDeps {
  client: ClaudeClient;
  cleanPath?: string;
  taggedPath?: string;
  model?: string;
  batchSize?: number;
  logger?: Logger;
}

export interface RunTaggingResult {
  totalPending: number; // 今回処理対象だった件数
  processed: number; // タグ付けに成功して書き出した件数
  skipped: number; // 既処理でスキップした件数
  untagged: string[]; // パース失敗等でタグ付けできなかったid
  needsReanonymize: string[]; // topics に「要匿名化再確認」を含んだid
}

// -----------------------------------------------------------------------------
// 応答パース: JSON配列を取り出す。素のparseに失敗したら [..] の範囲を切り出して再試行
// -----------------------------------------------------------------------------
export function parseTagResponse(text: string): TagItem[] | null {
  const tryParse = (s: string): TagItem[] | null => {
    try {
      const v: unknown = JSON.parse(s);
      return Array.isArray(v) ? (v as TagItem[]) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    return tryParse(text.slice(start, end + 1));
  }
  return null;
}

// -----------------------------------------------------------------------------
// TagItem を Fragment に反映（app由来のlayerは既存値を優先）
// -----------------------------------------------------------------------------
function applyTag(fragment: Fragment, item: TagItem): Fragment {
  const layers: FragmentLayer[] = ['thinking', 'style', 'knowledge'];
  const registers: FragmentRegister[] = ['public', 'private', 'formal'];

  // topics: 文字列配列のみ採用
  const topics = Array.isArray(item.topics)
    ? item.topics.filter((t): t is string => typeof t === 'string')
    : fragment.topics;

  // layer: app由来は確定済みなので既存値を優先。それ以外はLLM出力を採用（不正なら既存）
  let layer = fragment.layer;
  if (fragment.source !== 'app') {
    if (typeof item.layer === 'string' && layers.includes(item.layer as FragmentLayer)) {
      layer = item.layer as FragmentLayer;
    }
  }

  // register: 妥当な値のみ採用
  let register = fragment.register;
  if (typeof item.register === 'string' && registers.includes(item.register as FragmentRegister)) {
    register = item.register as FragmentRegister;
  }

  // confidence: 0..1 の数値のみ採用
  let confidence = fragment.confidence;
  if (typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1) {
    confidence = item.confidence;
  }

  return { ...fragment, layer, topics, register, confidence };
}

function appendTaggedFragment(path: string, fragment: Fragment): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(fragment) + '\n');
}

// -----------------------------------------------------------------------------
// 本体（テストから直接呼べるようDI構造にしてある）
// -----------------------------------------------------------------------------
export async function runTagging(deps: RunTaggingDeps): Promise<RunTaggingResult> {
  const cleanPath = deps.cleanPath ?? PIPELINE_PATHS.clean;
  const taggedPath = deps.taggedPath ?? PIPELINE_PATHS.tagged;
  const model = deps.model ?? DEFAULT_MODEL;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = deps.logger ?? { log: console.log, warn: console.warn, error: console.error };

  if (!existsSync(cleanPath)) {
    throw new Error(
      `入力 ${cleanPath} が見つかりません。先に 02_anonymize を実行して ` +
        `${PIPELINE_PATHS.clean} を生成してください。`,
    );
  }

  const clean = readFragmentsJsonl(cleanPath);

  // 中断再開: 既にtaggedにあるidはスキップ
  const doneIds = new Set<string>();
  if (existsSync(taggedPath)) {
    for (const f of readFragmentsJsonl(taggedPath)) doneIds.add(f.id);
  }

  const pending = clean.filter((f) => !doneIds.has(f.id));
  const skipped = clean.length - pending.length;

  const result: RunTaggingResult = {
    totalPending: pending.length,
    processed: 0,
    skipped,
    untagged: [],
    needsReanonymize: [],
  };

  if (pending.length === 0) {
    log.log(
      clean.length === 0
        ? `${cleanPath} に断片がありません。`
        : `全 ${clean.length} 断片は処理済みです（完了済み）。`,
    );
    return result;
  }

  log.log(
    `タグ付け開始: 対象 ${pending.length} 断片（既処理 ${skipped} 件はスキップ） / モデル ${model} / バッチ ${batchSize}`,
  );

  const batchCount = Math.ceil(pending.length / batchSize);
  for (let bi = 0; bi < batchCount; bi++) {
    const batch = pending.slice(bi * batchSize, (bi + 1) * batchSize);
    const user = buildTaggingUserPrompt(batch);

    // 1回目 → 失敗なら1回だけリトライ
    let items: TagItem[] | null = null;
    for (let attempt = 0; attempt < 2 && !items; attempt++) {
      const res = await deps.client.complete({
        model,
        system: TAGGING_SYSTEM_PROMPT,
        user,
        maxTokens: TAG_MAX_TOKENS,
      });
      items = parseTagResponse(res.text);
      if (!items && attempt === 0) {
        log.warn(`バッチ ${bi + 1}/${batchCount}: 応答パース失敗。1回だけ再試行します。`);
      }
    }

    if (!items) {
      // なお失敗: バッチ内をuntaggedとして継続（全体は止めない）
      log.error(
        `バッチ ${bi + 1}/${batchCount}: 応答パースに失敗しました。この ${batch.length} 断片は未タグのままにします。`,
      );
      for (const f of batch) result.untagged.push(f.id);
      continue;
    }

    const byId = new Map<string, TagItem>();
    for (const it of items) {
      if (it && typeof it.id === 'string') byId.set(it.id, it);
    }

    for (const f of batch) {
      const item = byId.get(f.id);
      if (!item) {
        // 応答に該当idが無い → 未タグとして次回に回す
        result.untagged.push(f.id);
        continue;
      }
      const tagged = applyTag(f, item);
      appendTaggedFragment(taggedPath, tagged);
      result.processed += 1;
      if (tagged.topics.includes(REANONYMIZE_TOPIC)) {
        result.needsReanonymize.push(tagged.id);
      }
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
function parseCliArgs(argv: string[]): { model?: string; batchSize?: number; provider: Provider } {
  const out: { model?: string; batchSize?: number; provider: Provider } = {
    provider: DEFAULT_PROVIDER,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') {
      out.model = argv[++i];
    } else if (a === '--batch-size') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.batchSize = Math.floor(n);
    } else if (a === '--provider') {
      const v = argv[++i];
      if (v === 'gemini' || v === 'claude') out.provider = v;
      else throw new Error(`--provider は gemini または claude を指定してください（受領: ${v}）`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  // 既定プロバイダは Gemini（無料枠で回せる。ユーザー決定 2026-07-10）。
  // --provider claude と --model claude-sonnet-5 の組合せで従来動作。
  const client = args.provider === 'claude' ? createClaudeClient() : createGeminiClient();
  const result = await runTagging({
    client,
    model: args.model ?? PROVIDER_DEFAULT_MODEL[args.provider],
    batchSize: args.batchSize,
  });

  // 要匿名化再確認の警告一覧（stderr）
  if (result.needsReanonymize.length > 0) {
    console.warn(
      `\n⚠ 「${REANONYMIZE_TOPIC}」が付いた断片が ${result.needsReanonymize.length} 件あります。02の再確認を推奨:`,
    );
    for (const id of result.needsReanonymize) console.warn(`    ${id}`);
  }

  // 未タグ一覧（stderr）
  if (result.untagged.length > 0) {
    console.warn(`\n⚠ 未タグのまま残った断片が ${result.untagged.length} 件あります（次回再実行で再処理）:`);
    for (const id of result.untagged) console.warn(`    ${id}`);
  }

  console.log(
    `\n✔ タグ付け完了: 処理 ${result.processed} 件 / スキップ ${result.skipped} 件 / 未タグ ${result.untagged.length} 件`,
  );
  console.log(`  ${client.formatUsage()}`);
}

// tsx で直接起動されたときのみ実行（テストからのimportでは実行しない）
if (process.argv[1] && process.argv[1].endsWith('03_tag.ts')) {
  main().catch((err) => {
    console.error('\n✖ 03_tag でエラー:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
