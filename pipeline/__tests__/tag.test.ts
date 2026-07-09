// =============================================================================
// 03_tag と claude-api ラッパのユニットテスト（実APIは呼ばない。モックDI）
// =============================================================================
import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readFragmentsJsonl,
  writeFragmentsJsonl,
  type Fragment,
} from '../lib/fragment';
import { runTagging, type Logger } from '../scripts/03_tag';
import {
  createClaudeClient,
  type ClaudeClient,
  type ClaudeCompleteOptions,
  type ClaudeCompletionResult,
} from '../lib/claude-api';

const FIXTURE_CLEAN = resolve(__dirname, 'fixtures/tag/clean_sample.jsonl');

// -----------------------------------------------------------------------------
// ヘルパ
// -----------------------------------------------------------------------------
function tmpWorkdir(): string {
  return mkdtempSync(join(tmpdir(), 'tag-test-'));
}

/** 応答テキストを差し込めるモックClaudeClient */
function makeMockClient(
  responder: (opts: ClaudeCompleteOptions) => string,
): { client: ClaudeClient; calls: ClaudeCompleteOptions[] } {
  const calls: ClaudeCompleteOptions[] = [];
  const client: ClaudeClient = {
    totals: { requests: 0, inputTokens: 0, outputTokens: 0, byModel: {} },
    async complete(opts) {
      calls.push(opts);
      return { text: responder(opts), inputTokens: 10, outputTokens: 5 };
    },
    estimateCostUsd: () => 0,
    formatUsage: () => 'mock',
  };
  return { client, calls };
}

const silentLogger: Logger = { log: () => {}, warn: () => {}, error: () => {} };

/** user プロンプトから最初の断片idを取り出す */
function firstIdIn(user: string): string {
  const m = user.match(/frg_[a-z]+_\d{6}/);
  return m ? m[0] : '';
}

function tagArrayFor(ids: string[], overrides: Record<string, object> = {}): string {
  return JSON.stringify(
    ids.map((id) => ({
      id,
      layer: 'style',
      topics: ['文章論'],
      register: 'public',
      confidence: 0.8,
      ...(overrides[id] ?? {}),
    })),
  );
}

// -----------------------------------------------------------------------------
// 03_tag
// -----------------------------------------------------------------------------
describe('runTagging', () => {
  it('① モック応答から Fragment にタグを反映する', async () => {
    const dir = tmpWorkdir();
    const cleanPath = join(dir, 'clean.jsonl');
    const taggedPath = join(dir, 'tagged.jsonl');
    cpSync(FIXTURE_CLEAN, cleanPath);

    const ids = ['frg_app_000001', 'frg_note_000001', 'frg_claude_000001'];
    const { client } = makeMockClient(() => tagArrayFor(ids));

    const result = await runTagging({ client, cleanPath, taggedPath, logger: silentLogger });

    expect(result.processed).toBe(3);
    expect(result.untagged).toEqual([]);

    const tagged = readFragmentsJsonl(taggedPath);
    const note = tagged.find((f) => f.id === 'frg_note_000001')!;
    expect(note.layer).toBe('style'); // app以外はLLM出力を採用
    expect(note.topics).toEqual(['文章論']);
    expect(note.register).toBe('public');
    expect(note.confidence).toBe(0.8);
  });

  it('② app 由来の layer は既存値を優先し LLM 出力で上書きしない', async () => {
    const dir = tmpWorkdir();
    const cleanPath = join(dir, 'clean.jsonl');
    const taggedPath = join(dir, 'tagged.jsonl');
    cpSync(FIXTURE_CLEAN, cleanPath);

    const ids = ['frg_app_000001', 'frg_note_000001', 'frg_claude_000001'];
    // app 断片に対して LLM が layer:"style" を返しても、既存の "thinking" を保持する
    const { client } = makeMockClient(() =>
      tagArrayFor(ids, { frg_app_000001: { layer: 'style', topics: ['教育観'] } }),
    );

    await runTagging({ client, cleanPath, taggedPath, logger: silentLogger });

    const tagged = readFragmentsJsonl(taggedPath);
    const app = tagged.find((f) => f.id === 'frg_app_000001')!;
    expect(app.layer).toBe('thinking'); // 上書きされない
    expect(app.topics).toEqual(['教育観']); // topics は反映される
  });

  it('③ 中断再開: 処理済みidはスキップして残りだけ処理する', async () => {
    const dir = tmpWorkdir();
    const cleanPath = join(dir, 'clean.jsonl');
    const taggedPath = join(dir, 'tagged.jsonl');
    cpSync(FIXTURE_CLEAN, cleanPath);

    // frg_app_000001 は既にタグ付け済みとして tagged に配置
    const already = readFragmentsJsonl(cleanPath).find((f) => f.id === 'frg_app_000001')!;
    writeFragmentsJsonl(taggedPath, [{ ...already, topics: ['済み'] }]);

    const ids = ['frg_note_000001', 'frg_claude_000001'];
    const { client, calls } = makeMockClient((opts) => {
      // 応答は user に含まれるidだけ返す（app が来ていないことも検証）
      const included = ids.filter((id) => opts.user.includes(id));
      return tagArrayFor(included);
    });

    const result = await runTagging({ client, cleanPath, taggedPath, logger: silentLogger });

    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(2);
    // どのバッチ呼び出しにも処理済みidは含まれない
    for (const c of calls) expect(c.user).not.toContain('frg_app_000001');

    // 既存タグは温存され、重複追記されていない
    const tagged = readFragmentsJsonl(taggedPath);
    expect(tagged.filter((f) => f.id === 'frg_app_000001')).toHaveLength(1);
    expect(tagged.find((f) => f.id === 'frg_app_000001')!.topics).toEqual(['済み']);
  });

  it('④ パース失敗バッチは1回リトライ後スキップし、他バッチは継続する', async () => {
    const dir = tmpWorkdir();
    const cleanPath = join(dir, 'clean.jsonl');
    const taggedPath = join(dir, 'tagged.jsonl');
    cpSync(FIXTURE_CLEAN, cleanPath);

    let noteAttempts = 0;
    const { client } = makeMockClient((opts) => {
      const id = firstIdIn(opts.user);
      if (id === 'frg_note_000001') {
        noteAttempts += 1;
        return 'これはJSONではありません'; // 常に失敗させる
      }
      return tagArrayFor([id]); // 他の断片は成功
    });

    const result = await runTagging({
      client,
      cleanPath,
      taggedPath,
      batchSize: 1, // 1断片=1バッチにして失敗バッチを分離
      logger: silentLogger,
    });

    expect(noteAttempts).toBe(2); // 1回目＋リトライ1回
    expect(result.untagged).toContain('frg_note_000001');
    expect(result.processed).toBe(2); // 残り2件は成功
    const taggedIds = readFragmentsJsonl(taggedPath).map((f) => f.id);
    expect(taggedIds).toContain('frg_app_000001');
    expect(taggedIds).toContain('frg_claude_000001');
    expect(taggedIds).not.toContain('frg_note_000001');
  });

  it('⑤ 02未実行（clean無し）なら明確なエラーで停止する', async () => {
    const dir = tmpWorkdir();
    const cleanPath = join(dir, 'missing.jsonl');
    const taggedPath = join(dir, 'tagged.jsonl');
    const { client } = makeMockClient(() => '[]');

    await expect(
      runTagging({ client, cleanPath, taggedPath, logger: silentLogger }),
    ).rejects.toThrow(/02_anonymize/);
  });

  it('「要匿名化再確認」を含む断片を needsReanonymize に集める', async () => {
    const dir = tmpWorkdir();
    const cleanPath = join(dir, 'clean.jsonl');
    const taggedPath = join(dir, 'tagged.jsonl');
    cpSync(FIXTURE_CLEAN, cleanPath);

    const ids = ['frg_app_000001', 'frg_note_000001', 'frg_claude_000001'];
    const { client } = makeMockClient(() =>
      tagArrayFor(ids, {
        frg_claude_000001: { topics: ['要匿名化再確認'], confidence: 0 },
      }),
    );

    const result = await runTagging({ client, cleanPath, taggedPath, logger: silentLogger });
    expect(result.needsReanonymize).toEqual(['frg_claude_000001']);
  });
});

// -----------------------------------------------------------------------------
// claude-api ラッパ
// -----------------------------------------------------------------------------
describe('createClaudeClient', () => {
  it('リトライ: 429 を1回受けてから成功する（指数バックオフ、sleepはモック）', async () => {
    let attempts = 0;
    const rawComplete = async (): Promise<ClaudeCompletionResult> => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      return { text: 'ok', inputTokens: 100, outputTokens: 50 };
    };
    const sleeps: number[] = [];
    const client = createClaudeClient({
      rawComplete,
      baseDelayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const res = await client.complete({
      model: 'claude-sonnet-5',
      system: 's',
      user: 'u',
      maxTokens: 100,
    });

    expect(res.text).toBe('ok');
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([10]); // 1回だけバックオフ（baseDelay * 2^0）
  });

  it('リトライ非対象（400）は即座に投げ、再試行しない', async () => {
    let attempts = 0;
    const client = createClaudeClient({
      rawComplete: async () => {
        attempts += 1;
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
      sleep: async () => {},
    });

    await expect(
      client.complete({ model: 'claude-sonnet-5', system: 's', user: 'u', maxTokens: 10 }),
    ).rejects.toThrow(/bad request/);
    expect(attempts).toBe(1);
  });

  it('累計トークンとモデル別概算コストを集計する', async () => {
    const client = createClaudeClient({
      rawComplete: async () => ({ text: 'x', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      sleep: async () => {},
    });

    await client.complete({ model: 'claude-sonnet-5', system: 's', user: 'u', maxTokens: 10 });
    await client.complete({ model: 'claude-fable-5', system: 's', user: 'u', maxTokens: 10 });

    expect(client.totals.requests).toBe(2);
    expect(client.totals.inputTokens).toBe(2_000_000);
    // sonnet-5: 100万×($3+$15)=18 / fable-5: 100万×($10+$50)=60 → 合計78
    expect(client.estimateCostUsd()).toBeCloseTo(18 + 60, 6);
  });
});
