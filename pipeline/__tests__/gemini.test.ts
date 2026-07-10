import { afterEach, describe, expect, it, vi } from 'vitest';

import { MODEL_PRICING } from '../lib/claude-api';
import { createGeminiClient, createGeminiRawComplete, GEMINI_PRICING } from '../lib/gemini-api';

function geminiOkResponse(text: string, inTok = 100, outTok = 50) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: inTok, candidatesTokenCount: outTok },
    }),
    text: async () => '',
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gemini-api', () => {
  it('generateContent 応答をパースし text とトークンを返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse('タグ付け結果', 123, 45));
    vi.stubGlobal('fetch', fetchMock);

    const raw = createGeminiRawComplete('test-key');
    const res = await raw({ model: 'gemini-3.5-flash', system: 'S', user: 'U', maxTokens: 1000 });

    expect(res).toEqual({ text: 'タグ付け結果', inputTokens: 123, outputTokens: 45 });
    // エンドポイント・認証ヘッダ・リクエスト形式の検証
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
    );
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('S');
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'U' }] });
    expect(body.generationConfig.maxOutputTokens).toBe(1000);
  });

  it('429 はリトライされ、成功時に集計へ反映される（claude-api のリトライ共有）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      } as unknown as Response)
      .mockResolvedValueOnce(geminiOkResponse('ok', 10, 5));
    vi.stubGlobal('fetch', fetchMock);

    const client = createGeminiClient({ apiKey: 'k', sleep: async () => {} });
    const res = await client.complete({
      model: 'gemini-3.5-flash',
      system: 'S',
      user: 'U',
      maxTokens: 100,
    });

    expect(res.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.totals.requests).toBe(1);
    expect(client.totals.byModel['gemini-3.5-flash']).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('400 はリトライせず即時エラー', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = createGeminiClient({ apiKey: 'k', sleep: async () => {} });
    await expect(
      client.complete({ model: 'gemini-3.5-flash', system: 'S', user: 'U', maxTokens: 100 }),
    ).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('応答が空（candidatesなし）ならエラーにする', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ finishReason: 'SAFETY' }] }),
      text: async () => '',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const raw = createGeminiRawComplete('k');
    await expect(
      raw({ model: 'gemini-3.5-flash', system: 'S', user: 'U', maxTokens: 100 }),
    ).rejects.toThrow(/SAFETY/);
  });

  it('APIキー未設定なら AI Studio への誘導つきエラー', () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      expect(() => createGeminiRawComplete()).toThrow(/GEMINI_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    }
  });

  it('Gemini単価が MODEL_PRICING に登録され、コスト概算に反映される', async () => {
    expect(MODEL_PRICING['gemini-3.5-flash']).toEqual(GEMINI_PRICING['gemini-3.5-flash']);

    const fetchMock = vi.fn().mockResolvedValue(geminiOkResponse('x', 1_000_000, 1_000_000));
    vi.stubGlobal('fetch', fetchMock);
    const client = createGeminiClient({ apiKey: 'k' });
    await client.complete({ model: 'gemini-3.5-flash', system: 'S', user: 'U', maxTokens: 10 });
    // $1.50 (入力1M) + $9.00 (出力1M)
    expect(client.estimateCostUsd()).toBeCloseTo(10.5, 5);
  });
});
