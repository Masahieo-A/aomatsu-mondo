// =============================================================================
// 01_extract のユニットテスト
//   各パーサが fixture から期待どおりの Fragment を生成すること
//   （本人発話のみ抽出・相槌スキップ・origin 書式・決定的 id）、
//   app の choice 変換（export.ts と同一規則）、マージ書き込みの規則を検証。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseChatGpt,
  parseClaude,
  parseGemini,
  parseTextsDir,
  parseTensakuDir,
  parseFrontMatter,
  parseTextFile,
  parseTensakuFile,
  registerFromMedia,
  shouldSkipUtterance,
  buildAppFragments,
  extractApp,
  numberFragments,
  mergeFragments,
  type AppRow,
  type PartialFragment,
} from '../scripts/01_extract';
import { validateFragment, type Fragment } from '../lib/fragment';

const FIX = resolve(__dirname, 'fixtures', 'extract');
const readFix = (rel: string): unknown => JSON.parse(readFileSync(resolve(FIX, rel), 'utf8'));

// -----------------------------------------------------------------------------
// shouldSkipUtterance
// -----------------------------------------------------------------------------
describe('shouldSkipUtterance', () => {
  it('空文字・相槌はスキップ', () => {
    expect(shouldSkipUtterance('')).toBe(true);
    expect(shouldSkipUtterance('   ')).toBe(true);
    expect(shouldSkipUtterance('ありがとう')).toBe(true);
    expect(shouldSkipUtterance('続けて')).toBe(true);
    expect(shouldSkipUtterance('OK')).toBe(true);
    expect(shouldSkipUtterance('なるほど。')).toBe(true);
  });
  it('実質的な発話は残す', () => {
    expect(shouldSkipUtterance('宿題は本当に必要なのか根拠を整理したい')).toBe(false);
    // 50字以上なら相槌語を含んでも残す
    expect(
      shouldSkipUtterance('ありがとう、とても助かった。ついでにもう一つ、次の授業の導入をどう組み立てるか一緒に考えてほしいのだが'),
    ).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// ChatGPT
// -----------------------------------------------------------------------------
describe('parseChatGpt', () => {
  const result = parseChatGpt(readFix('chatgpt/conversations.json'));
  const frags = numberFragments(result.fragments);

  it('user 発話のみ抽出し、system/assistant/相槌を除く', () => {
    // conv1: user 2件(m2,m5)、相槌m4は除外 / conv-broken: skip / conv2: user 1件(n0)
    expect(frags).toHaveLength(3);
    for (const f of frags) expect(validateFragment(f).ok).toBe(true);
  });

  it('壊れた会話(mapping=null)と相槌をスキップ計上', () => {
    expect(result.skipped).toBe(2); // 壊れた会話1 + 相槌「ありがとう」1
  });

  it('直前の assistant 冒頭120字を context にする', () => {
    const m5 = frags.find((f) => f.origin === 'chatgpt:conv-aaa-111#5');
    expect(m5).toBeDefined();
    expect(m5!.context).toContain('宿題の教育効果');
    expect(m5!.context!.length).toBeLessThanOrEqual(120);
  });

  it('先頭 user 発話は context=null', () => {
    const n0 = frags.find((f) => f.origin === 'chatgpt:conv-bbb-222#0');
    expect(n0!.context).toBeNull();
  });

  it('origin は chatgpt:<conv id>#<連番>、created_at は ISO', () => {
    const m2 = frags.find((f) => f.origin === 'chatgpt:conv-aaa-111#2');
    expect(m2).toBeDefined();
    expect(m2!.source).toBe('chatgpt');
    expect(m2!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('id は入力順に決定的採番', () => {
    expect(frags.map((f) => f.id)).toEqual([
      'frg_chatgpt_000001',
      'frg_chatgpt_000002',
      'frg_chatgpt_000003',
    ]);
  });
});

// -----------------------------------------------------------------------------
// Claude
// -----------------------------------------------------------------------------
describe('parseClaude', () => {
  const result = parseClaude(readFix('claude/conversations.json'));
  const frags = numberFragments(result.fragments);

  it('human 発話のみ抽出（相槌・壊れた会話を除外）', () => {
    // conv1: human msg-1,msg-4（msg-3「続けて」除外） / 壊れた会話skip / conv3: human msg-b
    expect(frags).toHaveLength(3);
    expect(result.skipped).toBe(2); // 壊れた会話1 + 「続けて」1
  });

  it('origin は claude:<uuid>#<idx>', () => {
    expect(frags[0].origin).toBe('claude:11111111-2222-3333-4444-555555555555#0');
    expect(frags[1].origin).toBe('claude:11111111-2222-3333-4444-555555555555#3');
  });

  it('直前 assistant を context に、先頭 human は null', () => {
    expect(frags[0].context).toBeNull();
    expect(frags[1].context).toContain('運用負荷');
    // conv3 は先頭が assistant → 次の human は context あり
    expect(frags[2].context).toContain('教材');
  });
});

// -----------------------------------------------------------------------------
// Gemini
// -----------------------------------------------------------------------------
describe('parseGemini', () => {
  const result = parseGemini(readFix('gemini/MyActivity.json'));
  const frags = numberFragments(result.fragments);

  it('プロンプトのみ抽出し "Prompted "/"プロンプト:" を除去', () => {
    expect(frags).toHaveLength(2);
    expect(frags[0].text.startsWith('三者面談')).toBe(true);
    expect(frags[1].text.startsWith('学級通信')).toBe(true);
  });

  it('相槌と空 title をスキップ', () => {
    expect(result.skipped).toBe(1); // 「Prompted ありがとう」（空 title は非計上）
  });

  it('origin は gemini:activity#<idx>（元配列の添字）', () => {
    expect(frags[0].origin).toBe('gemini:activity#0');
    expect(frags[1].origin).toBe('gemini:activity#2');
  });
});

// -----------------------------------------------------------------------------
// texts（front-matter）
// -----------------------------------------------------------------------------
describe('parseFrontMatter', () => {
  it('--- で囲む front-matter をパース', () => {
    const fm = parseFrontMatter('---\nsource: note\ndate: 2026-01-01\n---\n本文です');
    expect(fm).not.toBeNull();
    expect(fm!.meta.source).toBe('note');
    expect(fm!.body).toBe('本文です');
  });
  it('front-matter 無しは null', () => {
    expect(parseFrontMatter('# 見出し\n本文')).toBeNull();
  });
});

describe('parseTextFile', () => {
  it('note→public, work→formal に対応付け', () => {
    const note = parseTextFile('---\nsource: note\n---\nあ', 'a.md');
    expect(note!.source).toBe('note');
    expect(note!.register).toBe('public');
    const work = parseTextFile('---\nsource: work\n---\nい', 'b.md');
    expect(work!.source).toBe('work');
    expect(work!.register).toBe('formal');
  });
  it('未対応 source は null', () => {
    expect(parseTextFile('---\nsource: blog\n---\nx', 'c.md')).toBeNull();
  });
});

describe('parseTextsDir', () => {
  const result = parseTextsDir(resolve(FIX, 'texts'));
  const frags = numberFragments(result.fragments);

  it('front-matter 付き md/txt を1ファイル=1断片で抽出、無しはスキップ', () => {
    // note-kyoiku.md, x-post.txt, sub/work-proposal.md = 3件 / no-frontmatter.md skip
    expect(frags).toHaveLength(3);
    expect(result.skipped).toBe(1);
  });

  it('origin は相対パス、source ごとに id 採番', () => {
    const origins = frags.map((f) => f.origin).sort();
    expect(origins).toContain('texts:note-kyoiku.md');
    expect(origins).toContain('texts:x-post.txt');
    expect(origins).toContain(`texts:${['sub', 'work-proposal.md'].join('/')}`);
    // 3種の FragmentSource がそれぞれ 1 から採番される
    expect(frags.map((f) => f.id).sort()).toEqual([
      'frg_note_000001',
      'frg_work_000001',
      'frg_x_000001',
    ]);
  });

  it('created_at・register が front-matter 由来', () => {
    const note = frags.find((f) => f.origin === 'texts:note-kyoiku.md')!;
    expect(note.created_at).toBe('2026-01-15');
    expect(note.register).toBe('public');
  });
});

// -----------------------------------------------------------------------------
// tensaku
// -----------------------------------------------------------------------------
describe('registerFromMedia', () => {
  it('note/x→public, 公文書→formal, 他→private', () => {
    expect(registerFromMedia('note')).toBe('public');
    expect(registerFromMedia('x')).toBe('public');
    expect(registerFromMedia('公文書')).toBe('formal');
    expect(registerFromMedia('教材')).toBe('private');
    expect(registerFromMedia('その他')).toBe('private');
  });
});

describe('parseTensakuFile', () => {
  it('3セクションを構造抽出し text に結合、layer=null', () => {
    const content = readFileSync(resolve(FIX, 'tensaku/20260401_note-jyogen.md'), 'utf8');
    const f = parseTensakuFile(content, '20260401_note-jyogen.md')!;
    expect(f.layer).toBeNull();
    expect(f.register).toBe('public'); // media: note
    expect(f.text).toContain('【AI出力】');
    expect(f.text).toContain('【本人修正】');
    expect(f.text).toContain('【修正理由】');
    expect(f.text).toContain('説明的すぎる');
    expect(f.origin).toBe('tensaku:20260401_note-jyogen.md');
    expect(f.created_at).toBe('2026-04-01');
  });
  it('AI出力・本人修正の双方が空なら null', () => {
    const content = readFileSync(resolve(FIX, 'tensaku/broken.md'), 'utf8');
    expect(parseTensakuFile(content, 'broken.md')).toBeNull();
  });
});

describe('parseTensakuDir', () => {
  const result = parseTensakuDir(resolve(FIX, 'tensaku'));
  const frags = numberFragments(result.fragments);
  it('有効な差分のみ抽出、記入途中はスキップ', () => {
    expect(frags).toHaveLength(2);
    expect(result.skipped).toBe(1);
    expect(frags.find((f) => f.register === 'formal')).toBeDefined(); // 公文書
  });
});

// -----------------------------------------------------------------------------
// app（Supabase モック注入）
// -----------------------------------------------------------------------------
const APP_ROWS: AppRow[] = [
  {
    seq: 1,
    answer_text: '答えは状況次第だが、私は基本的に生徒の主体性を優先する。',
    reason_text: null,
    choice: null,
    submitted_at: '2026-05-01T00:00:00Z',
    category: 'Q2',
    body: '生徒が締切を破ったとき、あなたはどうしますか。',
    body_options: null,
  },
  {
    // 選択式（Q1）: choice → 「A: 選択肢本文」に変換されるべき
    seq: 2,
    answer_text: null,
    reason_text: '効率より納得を優先したいから。20字以上の理由テキスト。',
    choice: 'A',
    submitted_at: '2026-05-02T00:00:00Z',
    category: 'Q1',
    body: '効率と納得、どちらを取るか。',
    body_options: { A: '納得を取る', B: '効率を取る' },
  },
];

describe('buildAppFragments', () => {
  const frags = buildAppFragments(APP_ROWS);

  it('text は Q/A(/理由) 形式、layer は CATEGORY_LAYER で確定', () => {
    expect(frags[0].text).toBe(
      'Q: 生徒が締切を破ったとき、あなたはどうしますか。\nA: 答えは状況次第だが、私は基本的に生徒の主体性を優先する。',
    );
    expect(frags[0].layer).toBe('thinking'); // Q2
    expect(frags[0].register).toBe('private');
  });

  it('選択式は export.ts と同じ「A: 選択肢本文」規則で本文化＋理由付加', () => {
    expect(frags[1].text).toBe(
      'Q: 効率と納得、どちらを取るか。\nA: A: 納得を取る\n理由: 効率より納得を優先したいから。20字以上の理由テキスト。',
    );
    expect(frags[1].layer).toBe('thinking'); // Q1
  });

  it('origin は app:ans_<4桁ゼロ埋め>、created_at は submitted_at', () => {
    expect(frags[0].origin).toBe('app:ans_0001');
    expect(frags[1].origin).toBe('app:ans_0002');
    expect(frags[0].created_at).toBe('2026-05-01T00:00:00Z');
  });
});

describe('extractApp（モック client）', () => {
  it('submitted かつ非スキップの絞り込みで問い合わせ、join を正規化', async () => {
    const calls: Array<[string, unknown]> = [];
    // Supabase クエリビルダのチェーンを最小モック（thenable）
    const query = {
      select: () => query,
      eq: (col: string, val: unknown) => {
        calls.push([col, val]);
        return query;
      },
      order: () => query,
      then: (onFulfilled: (r: { data: unknown; error: null }) => unknown) =>
        onFulfilled({
          data: [
            {
              seq: 7,
              answer_text: '本文',
              reason_text: null,
              choice: null,
              submitted_at: '2026-06-01T00:00:00Z',
              // join がオブジェクトで返るケース
              questions: { category: 'Q3', body: '意見を述べよ', body_options: null },
            },
            {
              seq: 8,
              answer_text: 'B案',
              reason_text: null,
              choice: null,
              submitted_at: '2026-06-02T00:00:00Z',
              // join が配列で返るケース
              questions: [{ category: 'Q7', body: '経歴は', body_options: null }],
            },
          ],
          error: null,
        }),
    };
    const client = { from: () => query } as unknown as SupabaseClient;

    const result = await extractApp(client);
    expect(result.fragments).toHaveLength(2);
    expect(calls).toContainEqual(['status', 'submitted']);
    expect(calls).toContainEqual(['skipped', false]);
    expect(result.fragments[0].layer).toBe('thinking'); // Q3
    expect(result.fragments[1].layer).toBe('knowledge'); // Q7（join 配列も正規化）
    expect(result.fragments[0].origin).toBe('app:ans_0007');
  });
});

// -----------------------------------------------------------------------------
// numberFragments / mergeFragments
// -----------------------------------------------------------------------------
describe('numberFragments', () => {
  it('FragmentSource ごとに 1 から連番', () => {
    const partials: PartialFragment[] = [
      { source: 'note', text: 'a', origin: 'texts:1', layer: null, topics: [], register: 'public', confidence: null, context: null, created_at: null, anonymized: false },
      { source: 'x', text: 'b', origin: 'texts:2', layer: null, topics: [], register: 'public', confidence: null, context: null, created_at: null, anonymized: false },
      { source: 'note', text: 'c', origin: 'texts:3', layer: null, topics: [], register: 'public', confidence: null, context: null, created_at: null, anonymized: false },
    ];
    expect(numberFragments(partials).map((f) => f.id)).toEqual([
      'frg_note_000001',
      'frg_x_000001',
      'frg_note_000002',
    ]);
  });
});

describe('mergeFragments', () => {
  const mk = (id: string, source: Fragment['source'], origin: string): Fragment => ({
    id,
    source,
    layer: null,
    topics: [],
    register: null,
    confidence: null,
    text: 't',
    context: null,
    created_at: null,
    origin,
    anonymized: false,
  });

  it('同一ソースの既存断片を置換し、他ソースは保持', () => {
    const existing = [
      mk('frg_chatgpt_000001', 'chatgpt', 'chatgpt:old#0'),
      mk('frg_app_000001', 'app', 'app:ans_0001'),
    ];
    const incoming = [mk('frg_chatgpt_000001', 'chatgpt', 'chatgpt:new#0')];
    const merged = mergeFragments(existing, 'chatgpt', incoming);
    expect(merged).toHaveLength(2);
    expect(merged.find((f) => f.source === 'app')).toBeDefined(); // 保持
    expect(merged.find((f) => f.origin === 'chatgpt:new#0')).toBeDefined();
    expect(merged.find((f) => f.origin === 'chatgpt:old#0')).toBeUndefined(); // 置換
  });

  it('texts は origin プレフィクスで note/x/work をまとめて置換', () => {
    const existing = [
      mk('frg_note_000001', 'note', 'texts:old.md'),
      mk('frg_x_000001', 'x', 'texts:oldx.md'),
      mk('frg_app_000001', 'app', 'app:ans_0001'),
    ];
    const incoming = [mk('frg_note_000001', 'note', 'texts:new.md')];
    const merged = mergeFragments(existing, 'texts', incoming);
    expect(merged.map((f) => f.origin).sort()).toEqual(['app:ans_0001', 'texts:new.md']);
  });
});
