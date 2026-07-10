// =============================================================================
// 青松AI パイプライン  Claude API 薄ラッパ
//   03_tag / 05_kernel_draft が共有する最小インターフェース。
//   - リトライ（429/529/5xx: 指数バックオフ、既定3回）
//   - 累計トークン集計とモデル別の概算コスト
//   - テスト容易性のため rawComplete を差し替え可能（DI）にしてある
//
//   依存: @anthropic-ai/sdk（このパッケージのみ追加を許可されている）
//   APIキーは .env.local から自前でパースして読む（scripts/seed.ts と同方式。dotenv不使用）
// =============================================================================
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// -----------------------------------------------------------------------------
// モデル別単価（USD / 100万トークン）
//   出典: claude-api スキル「Current Models」表（cached 2026-06-24）。
//   - claude-sonnet-5: 通常 $3.00 / $15.00。2026-08-31までの導入価格は $2.00 / $10.00。
//     概算は保守的に通常価格で計算する（導入期間は実額がこれより安くなる）。
//   - claude-fable-5:  $10.00 / $50.00
//   - claude-opus-4-8: $5.00 / $25.00
//   - claude-haiku-4-5: $1.00 / $5.00
// -----------------------------------------------------------------------------
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

// -----------------------------------------------------------------------------
// 公開インターフェース
// -----------------------------------------------------------------------------
export interface ClaudeCompleteOptions {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface ClaudeCompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number }>;
}

export interface ClaudeClient {
  /** 1リクエスト分の補完。system + user を渡し、本文テキストと消費トークンを返す */
  complete(opts: ClaudeCompleteOptions): Promise<ClaudeCompletionResult>;
  /** これまでの累計消費トークン（モデル別内訳つき） */
  readonly totals: UsageTotals;
  /** 累計の概算コスト（USD） */
  estimateCostUsd(): number;
  /** 「リクエストN件 / 入力… / 概算 $…」の1行サマリ */
  formatUsage(): string;
}

/** 実際のAPI呼び出し1回分。テストではこれを差し替えてSDKを介さずに動かす */
export type RawComplete = (opts: ClaudeCompleteOptions) => Promise<ClaudeCompletionResult>;

export interface CreateClaudeClientConfig {
  /** 明示指定するAPIキー。未指定なら process.env → .env.local の順で解決 */
  apiKey?: string;
  /** SDKを介さない補完関数（DI / テスト用）。指定するとAPIキーは不要 */
  rawComplete?: RawComplete;
  /** リトライ回数（既定3） */
  maxRetries?: number;
  /** 指数バックオフの基準ミリ秒（既定500 → 500,1000,2000...） */
  baseDelayMs?: number;
  /** スリープ関数（テストで即時解決に差し替え可能） */
  sleep?: (ms: number) => Promise<void>;
}

// -----------------------------------------------------------------------------
// .env.local パーサ（scripts/seed.ts と同じ最小実装。dotenv不使用）
// gemini-api.ts からも使うため export する。
// -----------------------------------------------------------------------------
export function loadEnvLocal(): Record<string, string> {
  const path = resolve(process.cwd(), '.env.local');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolveApiKey(explicit?: string): string {
  if (explicit) return explicit;
  const key = process.env.ANTHROPIC_API_KEY ?? loadEnvLocal().ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      '.env.local に ANTHROPIC_API_KEY=... を追加してください（03_tag / 05_kernel_draft はこのキーを使用します）。',
    );
  }
  return key;
}

// -----------------------------------------------------------------------------
// リトライ判定・実行
// -----------------------------------------------------------------------------
function isRetriableError(err: unknown): boolean {
  // ネットワーク断は再試行対象
  if (err instanceof Anthropic.APIConnectionError) return true;
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') {
    return status === 429 || status === 529 || status >= 500;
  }
  return false;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetriableError(err)) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

// -----------------------------------------------------------------------------
// SDK を用いた既定の rawComplete
//   ストリーミングで受ける（大きな max_tokens でも HTTPタイムアウトを避けるため。
//   claude-api スキルの推奨）。SDK 自体のリトライは切り、本ラッパのリトライに一本化する。
//   thinking パラメータは渡さない: fable-5 は思考が常時ON（disabled指定は400）、
//   sonnet-5 は省略でadaptive。sampling系（temperature等）も4.7+系では400になるため渡さない。
// -----------------------------------------------------------------------------
function createSdkRawComplete(apiKey?: string): RawComplete {
  const key = resolveApiKey(apiKey);
  const client = new Anthropic({ apiKey: key, maxRetries: 0 });
  return async (opts) => {
    const stream = client.messages.stream({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
    });
    const message = await stream.finalMessage();
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
    };
  };
}

// -----------------------------------------------------------------------------
// クライアント生成
// -----------------------------------------------------------------------------
export function createClaudeClient(config: CreateClaudeClientConfig = {}): ClaudeClient {
  const maxRetries = config.maxRetries ?? 3;
  const baseDelayMs = config.baseDelayMs ?? 500;
  const sleep = config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // SDKの初期化（＝APIキー解決）は初回complete時まで遅延させる。
  // rawComplete をDIしたテストではキー無しでも動く。
  let raw = config.rawComplete;
  const getRaw = (): RawComplete => {
    if (!raw) raw = createSdkRawComplete(config.apiKey);
    return raw;
  };

  const totals: UsageTotals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    byModel: {},
  };

  const estimateCostUsd = (): number => {
    let cost = 0;
    for (const [model, u] of Object.entries(totals.byModel)) {
      const p = MODEL_PRICING[model];
      if (!p) continue; // 未知モデルはコスト集計から除外（トークンは集計済み）
      cost += (u.inputTokens / 1_000_000) * p.input + (u.outputTokens / 1_000_000) * p.output;
    }
    return cost;
  };

  return {
    totals,
    async complete(opts) {
      const result = await withRetry(() => getRaw()(opts), maxRetries, baseDelayMs, sleep);
      totals.requests += 1;
      totals.inputTokens += result.inputTokens;
      totals.outputTokens += result.outputTokens;
      const m = (totals.byModel[opts.model] ??= { inputTokens: 0, outputTokens: 0 });
      m.inputTokens += result.inputTokens;
      m.outputTokens += result.outputTokens;
      return result;
    },
    estimateCostUsd,
    formatUsage() {
      return (
        `リクエスト ${totals.requests}件 / ` +
        `入力 ${totals.inputTokens.toLocaleString()} tok・` +
        `出力 ${totals.outputTokens.toLocaleString()} tok / ` +
        `概算コスト $${estimateCostUsd().toFixed(4)}`
      );
    },
  };
}
