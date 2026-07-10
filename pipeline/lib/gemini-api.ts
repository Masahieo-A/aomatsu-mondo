// =============================================================================
// 青松AI パイプライン  Gemini API 薄ラッパ
//   claude-api.ts と同一インターフェース（ClaudeClient）を返す。実装は
//   createClaudeClient に Gemini REST 呼び出しの rawComplete を注入するだけなので、
//   リトライ・トークン集計・コスト概算のロジックは共有される。
//
//   認証: GEMINI_API_KEY（process.env → .env.local）。Google AI Studio
//   (https://aistudio.google.com) でクレジットカード無しで発行できる。
//   REST: POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
//         ヘッダ x-goog-api-key（出典: ai.google.dev/gemini-api/docs、確認日 2026-07-10）
// =============================================================================
import {
  createClaudeClient,
  loadEnvLocal,
  MODEL_PRICING,
  type ClaudeClient,
  type ClaudeCompleteOptions,
  type ClaudeCompletionResult,
  type CreateClaudeClientConfig,
  type RawComplete,
} from './claude-api';

// -----------------------------------------------------------------------------
// モデル別単価（USD / 100万トークン）
//   出典: ai.google.dev/gemini-api/docs/pricing ほか（確認日 2026-07-10）。
//   - gemini-3.5-flash: $1.50 / $9.00（**無料枠対象**。AI Studioの無料キーなら
//     レート制限内で $0。概算コストは有料単価で保守的に表示する）
//   - gemini-3.1-pro:   フラッグシップ（有料のみ）。単価は $2.00 / $12.00 と推定
//     （3.5-flash が「3.1 Proより25%安い」との情報からの逆算。正確な値は公式で要確認）
//   MODEL_PRICING（claude-api.ts）に登録し、コスト集計を共通化する。
// -----------------------------------------------------------------------------
export const GEMINI_PRICING: Record<string, { input: number; output: number }> = {
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'gemini-3.1-pro': { input: 2.0, output: 12.0 },
};
Object.assign(MODEL_PRICING, GEMINI_PRICING);

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

function resolveGeminiApiKey(explicit?: string): string {
  if (explicit) return explicit;
  const key = process.env.GEMINI_API_KEY ?? loadEnvLocal().GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      '.env.local に GEMINI_API_KEY=... を追加してください（https://aistudio.google.com で無料発行できます）。',
    );
  }
  return key;
}

// -----------------------------------------------------------------------------
// generateContent 応答の最小型（知らないフィールドは無視する防御的パース）
// -----------------------------------------------------------------------------
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string };
}

/** claude-api.ts の isRetriableError が拾えるよう、status を持つエラーを投げる */
class GeminiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiHttpError';
  }
}

export function createGeminiRawComplete(apiKey?: string): RawComplete {
  const key = resolveGeminiApiKey(apiKey);
  return async (opts: ClaudeCompleteOptions): Promise<ClaudeCompletionResult> => {
    let res: Response;
    try {
      res = await fetch(`${GEMINI_ENDPOINT}/${opts.model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: opts.system }] },
          contents: [{ role: 'user', parts: [{ text: opts.user }] }],
          generationConfig: { maxOutputTokens: opts.maxTokens },
        }),
      });
    } catch (e) {
      // ネットワーク断: リトライ対象になるよう status 付きで投げ直す
      throw new GeminiHttpError(599, `接続エラー: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new GeminiHttpError(res.status, `Gemini API ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as GeminiResponse;
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? '').join('');
    if (text.length === 0) {
      const reason = json.candidates?.[0]?.finishReason ?? json.error?.message ?? '不明';
      throw new GeminiHttpError(500, `Gemini応答が空です（finishReason: ${reason}）`);
    }
    return {
      text,
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    };
  };
}

/**
 * Gemini版クライアント。インターフェースは ClaudeClient と同一（DI・集計・リトライ共有）。
 * APIキー解決は初回 complete 時まで遅延（rawComplete をDIしたテストではキー不要）。
 */
export function createGeminiClient(config: CreateClaudeClientConfig = {}): ClaudeClient {
  let raw = config.rawComplete;
  const lazyRaw: RawComplete = (opts) => {
    if (!raw) raw = createGeminiRawComplete(config.apiKey);
    return raw(opts);
  };
  return createClaudeClient({ ...config, rawComplete: lazyRaw });
}
