import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCrossModelReportMd,
  buildFactsCandidatesMd,
  buildIndexMd,
  buildStyleSamplesMd,
  buildThinkingTopicFiles,
  computeCrossModelSummary,
  computeTopicModelStats,
  filterAnonymized,
  findCanonicalCrossrefTopics,
  formatFragmentQuote,
  groupAiLogFragmentsByTopic,
  loadTaggedFragments,
  sanitizeTopicFilename,
  sortFragmentsForMaterials,
  summarizeFragments,
} from '../scripts/04_integrate';
import type { Fragment } from '../lib/fragment';

const FIXTURE_PATH = resolve(__dirname, 'fixtures/integrate/tagged_sample.jsonl');

// -----------------------------------------------------------------------------
// テスト用の最小Fragmentビルダー
// -----------------------------------------------------------------------------
function makeFragment(overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: 'frg_app_000001',
    source: 'app',
    layer: 'thinking',
    topics: ['教育観'],
    register: 'private',
    confidence: 0.5,
    text: 'ダミー本文',
    context: null,
    created_at: '2026-01-01T00:00:00Z',
    origin: 'app:ans_0001',
    anonymized: true,
    ...overrides,
  };
}

describe('loadTaggedFragments / filterAnonymized', () => {
  it('存在しないパスを渡すと「先に03を実行」を含むエラーを投げる', () => {
    expect(() => loadTaggedFragments(resolve(__dirname, 'fixtures/integrate/does_not_exist.jsonl'))).toThrow(
      /先に03を実行/,
    );
  });

  it('③ anonymized=false の断片を除外し、件数を報告する', () => {
    const all = loadTaggedFragments(FIXTURE_PATH);
    expect(all.length).toBe(12);

    const { kept, excludedCount } = filterAnonymized(all);
    expect(excludedCount).toBe(1);
    expect(kept.length).toBe(11);
    expect(kept.some((f) => f.origin === 'chatgpt:conv9#9')).toBe(false);
  });
});

describe('sanitizeTopicFilename', () => {
  it('④ / と空白類を _ に安全化する', () => {
    expect(sanitizeTopicFilename('時間 管理/優先度')).toBe('時間_管理_優先度');
  });

  it('④ 安全な日本語トピック名はそのまま', () => {
    expect(sanitizeTopicFilename('教育観')).toBe('教育観');
  });

  it('④ 全角スペースや連続する記号もまとめて1つの _ にする', () => {
    expect(sanitizeTopicFilename('文体　規則:テスト')).toBe('文体_規則_テスト');
  });
});

describe('sortFragmentsForMaterials', () => {
  it('① sourcePriority降順→confidence降順で並べる（正典が上に来る）', () => {
    // app(priority2, confidence低) が claude(priority1, confidence高) より優先される
    const app = makeFragment({ id: 'frg_app_000001', source: 'app', confidence: 0.5, origin: 'app:ans_0001' });
    const claude = makeFragment({
      id: 'frg_claude_000001',
      source: 'claude',
      confidence: 0.9,
      origin: 'claude:conv1#1',
    });
    const chatgpt = makeFragment({
      id: 'frg_chatgpt_000001',
      source: 'chatgpt',
      confidence: 0.6,
      origin: 'chatgpt:conv1#1',
    });

    const sorted = sortFragmentsForMaterials([claude, chatgpt, app]);
    expect(sorted.map((f) => f.origin)).toEqual(['app:ans_0001', 'claude:conv1#1', 'chatgpt:conv1#1']);
  });
});

describe('formatFragmentQuote', () => {
  it('「> 引用本文」+「— [出典ID] (source, created_at, confidence)」形式になる', () => {
    const f = makeFragment({
      text: '生徒には失敗を恐れず挑戦してほしい。',
      origin: 'app:ans_0001',
      source: 'app',
      created_at: '2026-01-05T00:00:00Z',
      confidence: 0.5,
    });
    expect(formatFragmentQuote(f)).toBe(
      '> 生徒には失敗を恐れず挑戦してほしい。\n— [app:ans_0001] (app, 2026-01-05T00:00:00Z, 0.5)',
    );
  });
});

describe('buildThinkingTopicFiles', () => {
  const all = loadTaggedFragments(FIXTURE_PATH);
  const { kept } = filterAnonymized(all);
  const files = buildThinkingTopicFiles(kept);

  it('① トピック別にmdを生成する（複数トピックを持つ断片は各ファイルに複製配置）', () => {
    expect([...files.keys()].sort()).toEqual(
      ['教育観.md', '生徒との距離感.md', '時間_管理_優先度.md', '宿題の出し方.md'].sort(),
    );
  });

  it('① 教育観.md は sourcePriority→confidence の順で並ぶ（app→claude→chatgpt）', () => {
    const content = files.get('教育観.md')!;
    const order = [...content.matchAll(/\[([a-z]+:[^\]]+)\]/g)].map((m) => m[1]);
    expect(order).toEqual(['app:ans_0001', 'claude:conv1#3', 'chatgpt:conv9#5']);
  });

  it('④ 「時間 管理/優先度」は安全化されたファイル名で出力される', () => {
    expect(files.has('時間_管理_優先度.md')).toBe(true);
    expect(files.get('時間_管理_優先度.md')).toContain('タスクは緊急度より重要度で並べ替える');
  });

  it('style/knowledge層はthinkingのファイルに含まれない', () => {
    const content = [...files.values()].join('\n');
    expect(content).not.toContain('文章は削ってから始まる');
    expect(content).not.toContain('教員歴は5年ほど');
  });
});

describe('buildStyleSamplesMd', () => {
  const all = loadTaggedFragments(FIXTURE_PATH);
  const { kept } = filterAnonymized(all);
  const md = buildStyleSamplesMd(kept);

  it('register別にセクション分けされる', () => {
    expect(md).toContain('## 公開（Note/X等）');
    expect(md).toContain('## フォーマル（組織内文書）');
  });

  it('公開セクション内は sourcePriority が confidence より優先される（tensaku→note）', () => {
    const publicSection = md.split('## 公開（Note/X等）')[1].split('## フォーマル')[0];
    const tensakuIdx = publicSection.indexOf('tensaku:diff_2026_02#1');
    const noteIdx = publicSection.indexOf('note:2026-01-10-post#1');
    expect(tensakuIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeGreaterThan(-1);
    expect(tensakuIdx).toBeLessThan(noteIdx);
  });
});

describe('buildFactsCandidatesMd', () => {
  it('knowledge層のみを列挙し、facts.mdへの転記候補である旨のヘッダ注記を含む', () => {
    const all = loadTaggedFragments(FIXTURE_PATH);
    const { kept } = filterAnonymized(all);
    const md = buildFactsCandidatesMd(kept);

    expect(md).toContain('facts.md へ転記');
    expect(md).toContain('share');
    expect(md).toContain('国語科教員');
    expect(md).toContain('教員歴は5年ほど');
    expect(md).not.toContain('文章は削ってから始まる');
  });
});

describe('summarizeFragments / buildIndexMd', () => {
  const all = loadTaggedFragments(FIXTURE_PATH);
  const { kept } = filterAnonymized(all);
  const summary = summarizeFragments(kept);

  it('⑤ 層別・ソース別の件数が正しい', () => {
    expect(summary.total).toBe(11);
    expect(summary.byLayer).toEqual({ thinking: 6, knowledge: 2, style: 3 });
    expect(summary.bySource).toEqual({
      app: 2,
      claude: 3,
      chatgpt: 1,
      gemini: 2,
      note: 1,
      work: 1,
      tensaku: 1,
    });
  });

  it('⑤ トピック上位20に件数付きで含まれる', () => {
    const edu = summary.topTopics.find((t) => t.topic === '教育観');
    expect(edu?.count).toBe(3);
    const homework = summary.topTopics.find((t) => t.topic === '宿題の出し方');
    expect(homework?.count).toBe(2);
  });

  it('⑤ INDEX.md に生成ファイル一覧とサマリ数値が出力される', () => {
    const md = buildIndexMd(summary, ['thinking/教育観.md', 'style_samples.md', 'facts_candidates.md', 'cross-model-report.md']);
    expect(md).toContain('合計: 11件');
    expect(md).toContain('thinking: 6件');
    expect(md).toContain('claude: 3件');
    expect(md).toContain('教育観（3件）');
  });
});

describe('groupAiLogFragmentsByTopic / computeTopicModelStats（3モデル交差検証）', () => {
  const all = loadTaggedFragments(FIXTURE_PATH);
  const { kept } = filterAnonymized(all);
  const byTopic = groupAiLogFragmentsByTopic(kept);
  const stats = computeTopicModelStats(byTopic);

  it('② 「教育観」は claude/chatgpt の2モデルに現れる → 昇格候補', () => {
    const edu = stats.find((s) => s.topic === '教育観')!;
    expect(edu.modelCount).toBe(2);
    expect([...edu.fragmentsByModel.keys()].sort()).toEqual(['chatgpt', 'claude']);
  });

  it('② 「宿題の出し方」は gemini断片が2件あるが1モデルのみ → 適応疑い', () => {
    const homework = stats.find((s) => s.topic === '宿題の出し方')!;
    expect(homework.modelCount).toBe(1);
    expect(homework.fragmentsByModel.get('gemini')?.length).toBe(2);
  });

  it('② 「生徒との距離感」「経歴」「時間 管理/優先度」は単一モデルのみ', () => {
    for (const topic of ['生徒との距離感', '経歴', '時間 管理/優先度']) {
      const s = stats.find((t) => t.topic === topic)!;
      expect(s.modelCount).toBe(1);
    }
  });

  it('anonymized=false の断片（chatgptの無トピック断片）はグルーピングに影響しない', () => {
    expect(stats.length).toBe(5);
  });
});

describe('findCanonicalCrossrefTopics', () => {
  it('appの断片とAIログ断片が両方あるトピックのみを列挙する', () => {
    const all = loadTaggedFragments(FIXTURE_PATH);
    const { kept } = filterAnonymized(all);
    const stats = computeTopicModelStats(groupAiLogFragmentsByTopic(kept));
    const crossref = findCanonicalCrossrefTopics(kept, stats);

    expect(crossref.map((c) => c.topic).sort()).toEqual(['教育観', '経歴'].sort());
    const edu = crossref.find((c) => c.topic === '教育観')!;
    expect(edu.appCount).toBe(1);
    expect(edu.aiLogCount).toBe(2);
  });
});

describe('computeCrossModelSummary / buildCrossModelReportMd', () => {
  const all = loadTaggedFragments(FIXTURE_PATH);
  const { kept } = filterAnonymized(all);
  const stats = computeTopicModelStats(groupAiLogFragmentsByTopic(kept));
  const crossref = findCanonicalCrossrefTopics(kept, stats);

  it('② サマリ集計: トピック総数5 / 昇格候補1 / 適応疑い4 / 突き合わせ対象2', () => {
    const summary = computeCrossModelSummary(stats, crossref);
    expect(summary).toEqual({
      totalTopics: 5,
      promotedCount: 1,
      singleModelCount: 4,
      crossrefCount: 2,
    });
  });

  it('レポートに昇格候補・適応疑い・突き合わせ対象の各セクションが出力される', () => {
    const md = buildCrossModelReportMd(stats, crossref);

    expect(md).toContain('## カーネル昇格候補（2モデル以上に出現）');
    expect(md).toContain('### 教育観');
    expect(md).toContain('claude: 1件');
    expect(md).toContain('chatgpt: 1件');

    expect(md).toContain('## 単一モデルのみ（適応疑い）');
    expect(md).toContain('宿題の出し方');

    expect(md).toContain('## 正典との突き合わせ対象');
    expect(md).toContain('| 教育観 | 1 | 2 |');
    expect(md).toContain('| 経歴 | 1 | 1 |');
  });
});
