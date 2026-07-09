// =============================================================================
// 青松AI パイプライン  04_integrate — コーパス統合 + 3モデル交差検証レポート
//   要件: docs/requirements_aomatsu_ai.md 3.2（バイアス補正の運用原則）/ 3.3（統合）/ 4.2
//
//   入力: PIPELINE_PATHS.tagged（03_tag の出力）。anonymized=true の断片のみを対象とする。
//   出力1: corpus/materials/ への振り分け（既存ファイルは全再生成）
//     - thinking/<トピック>.md   … thinking層をトピック別に集約（出典ID付き引用列挙）
//     - style_samples.md         … style層を register 別にセクション分け
//     - facts_candidates.md      … knowledge層（facts.md への転記候補）
//     - INDEX.md                 … 生成ファイル一覧 + 断片数サマリ
//   出力2: cross-model-report.md（要件3.2-2の3モデル交差検証）
//     - AIログ由来断片をトピック別にグルーピングし、claude/chatgpt/gemini のうち
//       何モデルに現れるかを集計。2モデル以上→カーネル昇格候補、1モデルのみ→適応疑い。
//     - app（正典）と同トピックのAIログ断片があるトピックは「突き合わせ対象」として列挙
//       （矛盾の実判定は05_kernel_draftのLLMと本人が行うため、ここは機械的な列挙のみ）
//
//   CLI: npx tsx pipeline/scripts/04_integrate.ts
// =============================================================================
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FRAGMENT_SOURCES,
  type Fragment,
  type FragmentSource,
  PIPELINE_PATHS,
  isAiLogSource,
  readFragmentsJsonl,
  sourcePriority,
} from '../lib/fragment';

// -----------------------------------------------------------------------------
// 入力ロード・フィルタ
// -----------------------------------------------------------------------------

/** tagged断片を読み込む。無ければ「先に03を実行」を促すエラーを投げる。 */
export function loadTaggedFragments(path: string = PIPELINE_PATHS.tagged): Fragment[] {
  if (!existsSync(path)) {
    throw new Error(
      `タグ付け済み断片が見つかりません: ${path}\n` +
        `先に03を実行してください（npx tsx pipeline/scripts/03_tag.ts）。`,
    );
  }
  return readFragmentsJsonl(path);
}

export interface AnonymizedFilterResult {
  kept: Fragment[];
  excludedCount: number;
}

/** anonymized=true の断片だけを残す。false が混ざっていれば件数を返す（呼び出し側で警告）。 */
export function filterAnonymized(fragments: Fragment[]): AnonymizedFilterResult {
  const kept = fragments.filter((f) => f.anonymized);
  return { kept, excludedCount: fragments.length - kept.length };
}

// -----------------------------------------------------------------------------
// 共通ユーティリティ
// -----------------------------------------------------------------------------

/** トピック名をファイル名として安全化する（/・バックスラッシュ・空白類・記号を _ に置換）。 */
export function sanitizeTopicFilename(topic: string): string {
  return topic.replace(/[\s/\\:*?"<>|]+/g, '_');
}

/** 正典の優先順位（sourcePriority）降順→confidence降順で並べる（正典が上に来る）。 */
export function sortFragmentsForMaterials(fragments: Fragment[]): Fragment[] {
  return [...fragments].sort((a, b) => {
    const priorityDiff = sourcePriority(b.source) - sourcePriority(a.source);
    if (priorityDiff !== 0) return priorityDiff;
    const ca = a.confidence ?? -1;
    const cb = b.confidence ?? -1;
    return cb - ca;
  });
}

/** 「> 引用本文」+「— [出典ID] (source, created_at, confidence)」形式で1断片を整形する。 */
export function formatFragmentQuote(f: Fragment): string {
  const quoted = f.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const createdAt = f.created_at ?? '日時不明';
  const confidence = f.confidence === null ? '確信度不明' : f.confidence;
  return `${quoted}\n— [${f.origin}] (${f.source}, ${createdAt}, ${confidence})`;
}

function excerpt(text: string, maxLen = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

/** confidence降順（tie-breakはorigin昇順）で先頭の断片を代表として選ぶ。 */
function pickRepresentative(fragments: Fragment[]): Fragment {
  return [...fragments].sort((a, b) => {
    const ca = a.confidence ?? -1;
    const cb = b.confidence ?? -1;
    if (cb !== ca) return cb - ca;
    return a.origin.localeCompare(b.origin);
  })[0];
}

// -----------------------------------------------------------------------------
// 出力1: corpus/materials/ への振り分け
// -----------------------------------------------------------------------------

const REGISTER_LABELS: Record<'public' | 'private' | 'formal', string> = {
  public: '公開（Note/X等）',
  private: '私的（本音・AI相談等）',
  formal: 'フォーマル（組織内文書）',
};

/** thinking層をトピック別に集約する。1断片が複数トピックを持つ場合は各トピックのファイルに複製配置する。 */
export function buildThinkingTopicFiles(fragments: Fragment[]): Map<string, string> {
  const thinking = fragments.filter((f) => f.layer === 'thinking');
  const byTopic = new Map<string, Fragment[]>();
  for (const f of thinking) {
    for (const topic of f.topics) {
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      byTopic.get(topic)!.push(f);
    }
  }

  const files = new Map<string, string>();
  for (const [topic, frags] of byTopic) {
    const sorted = sortFragmentsForMaterials(frags);
    const body = sorted.map(formatFragmentQuote).join('\n\n');
    const content = `# ${topic}\n\n${body}\n`;
    files.set(`${sanitizeTopicFilename(topic)}.md`, content);
  }
  return files;
}

/** style層断片を register 別（public/private/formal/未分類）にセクション分けして列挙する。 */
export function buildStyleSamplesMd(fragments: Fragment[]): string {
  const style = fragments.filter((f) => f.layer === 'style');
  let md = '# 文体サンプル集\n\n';

  for (const register of ['public', 'private', 'formal'] as const) {
    const items = sortFragmentsForMaterials(style.filter((f) => f.register === register));
    if (items.length === 0) continue;
    md += `## ${REGISTER_LABELS[register]}\n\n`;
    md += `${items.map(formatFragmentQuote).join('\n\n')}\n\n`;
  }

  const unclassified = sortFragmentsForMaterials(style.filter((f) => f.register === null));
  if (unclassified.length > 0) {
    md += `## 未分類\n\n`;
    md += `${unclassified.map(formatFragmentQuote).join('\n\n')}\n\n`;
  }

  return `${md.trimEnd()}\n`;
}

/** knowledge層断片を facts.md への転記候補として列挙する。 */
export function buildFactsCandidatesMd(fragments: Fragment[]): string {
  const knowledge = sortFragmentsForMaterials(fragments.filter((f) => f.layer === 'knowledge'));
  const header =
    '# 事実DB転記候補\n\n' +
    '本人が内容を確認のうえ corpus/facts/facts.md へ転記し、各項目に as_of（時点情報）と ' +
    'share（ok|internal-only）フラグを付けてください。ここに列挙された候補はそのままでは事実DBに反映されません。\n\n';
  if (knowledge.length === 0) return `${header}（該当する断片はありません）\n`;
  return `${header}${knowledge.map(formatFragmentQuote).join('\n\n')}\n`;
}

export interface IntegrateSummary {
  total: number;
  byLayer: Record<string, number>;
  bySource: Partial<Record<FragmentSource, number>>;
  topTopics: Array<{ topic: string; count: number }>;
}

/** 層別・ソース別の件数とトピック上位20を集計する（全断片のtopicsを対象。層を問わない）。 */
export function summarizeFragments(fragments: Fragment[]): IntegrateSummary {
  const byLayer: Record<string, number> = {};
  const bySource: Partial<Record<FragmentSource, number>> = {};
  const topicCounts = new Map<string, number>();

  for (const f of fragments) {
    const layerKey = f.layer ?? '未分類';
    byLayer[layerKey] = (byLayer[layerKey] ?? 0) + 1;
    bySource[f.source] = (bySource[f.source] ?? 0) + 1;
    for (const topic of f.topics) {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
  }

  const topTopics = [...topicCounts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic, 'ja'))
    .slice(0, 20);

  return { total: fragments.length, byLayer, bySource, topTopics };
}

/** corpus/materials/INDEX.md の内容を組み立てる。 */
export function buildIndexMd(summary: IntegrateSummary, generatedFiles: string[]): string {
  let md = '# corpus/materials 生成インデックス\n\n';
  md += '04_integrate（コーパス統合）の出力一覧と断片数サマリ。実データで再生成すると内容は置き換わる。\n\n';

  md += '## 生成ファイル\n\n';
  for (const f of generatedFiles) md += `- ${f}\n`;

  md += '\n## 断片数サマリ\n\n';
  md += `合計: ${summary.total}件\n\n`;

  md += '### 層別\n\n';
  for (const [layer, count] of Object.entries(summary.byLayer).sort(([a], [b]) => a.localeCompare(b))) {
    md += `- ${layer}: ${count}件\n`;
  }

  md += '\n### ソース別\n\n';
  for (const source of FRAGMENT_SOURCES) {
    const count = summary.bySource[source];
    if (count) md += `- ${source}: ${count}件\n`;
  }

  md += '\n### トピック上位20\n\n';
  if (summary.topTopics.length === 0) {
    md += '（トピックがありません）\n';
  } else {
    summary.topTopics.forEach((t, i) => {
      md += `${i + 1}. ${t.topic}（${t.count}件）\n`;
    });
  }

  return `${md.trimEnd()}\n`;
}

// -----------------------------------------------------------------------------
// 出力2: 3モデル交差検証レポート（要件3.2-2）
// -----------------------------------------------------------------------------

export interface TopicModelStats {
  topic: string;
  fragmentsByModel: Map<FragmentSource, Fragment[]>;
  /** このトピックに現れる異なるAIモデルの数（claude/chatgpt/gemini） */
  modelCount: number;
}

/** AIログ由来断片（isAiLogSource）をトピック別にグルーピングする。 */
export function groupAiLogFragmentsByTopic(fragments: Fragment[]): Map<string, Fragment[]> {
  const aiLog = fragments.filter((f) => isAiLogSource(f.source));
  const byTopic = new Map<string, Fragment[]>();
  for (const f of aiLog) {
    for (const topic of f.topics) {
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      byTopic.get(topic)!.push(f);
    }
  }
  return byTopic;
}

/** トピックごとに「何モデルに現れるか」を集計する。 */
export function computeTopicModelStats(byTopic: Map<string, Fragment[]>): TopicModelStats[] {
  const stats: TopicModelStats[] = [];
  for (const [topic, frags] of byTopic) {
    const fragmentsByModel = new Map<FragmentSource, Fragment[]>();
    for (const f of frags) {
      if (!fragmentsByModel.has(f.source)) fragmentsByModel.set(f.source, []);
      fragmentsByModel.get(f.source)!.push(f);
    }
    stats.push({ topic, fragmentsByModel, modelCount: fragmentsByModel.size });
  }
  return stats;
}

export interface CrossrefTopic {
  topic: string;
  appCount: number;
  aiLogCount: number;
}

/** app（正典）の断片と同トピックのAIログ断片が両方あるトピックを列挙する。 */
export function findCanonicalCrossrefTopics(fragments: Fragment[], aiStats: TopicModelStats[]): CrossrefTopic[] {
  const aiCountByTopic = new Map<string, number>();
  for (const s of aiStats) {
    let total = 0;
    for (const frags of s.fragmentsByModel.values()) total += frags.length;
    aiCountByTopic.set(s.topic, total);
  }

  const appCountByTopic = new Map<string, number>();
  for (const f of fragments) {
    if (f.source !== 'app') continue;
    for (const topic of f.topics) {
      appCountByTopic.set(topic, (appCountByTopic.get(topic) ?? 0) + 1);
    }
  }

  const result: CrossrefTopic[] = [];
  for (const [topic, appCount] of appCountByTopic) {
    const aiLogCount = aiCountByTopic.get(topic);
    if (aiLogCount !== undefined) result.push({ topic, appCount, aiLogCount });
  }
  return result.sort((a, b) => a.topic.localeCompare(b.topic, 'ja'));
}

export interface CrossModelSummary {
  totalTopics: number;
  promotedCount: number;
  singleModelCount: number;
  crossrefCount: number;
}

export function computeCrossModelSummary(stats: TopicModelStats[], crossref: CrossrefTopic[]): CrossModelSummary {
  return {
    totalTopics: stats.length,
    promotedCount: stats.filter((s) => s.modelCount >= 2).length,
    singleModelCount: stats.filter((s) => s.modelCount === 1).length,
    crossrefCount: crossref.length,
  };
}

/** cross-model-report.md の内容を組み立てる（要件3.2-2）。 */
export function buildCrossModelReportMd(stats: TopicModelStats[], crossref: CrossrefTopic[]): string {
  const summary = computeCrossModelSummary(stats, crossref);
  const sorted = [...stats].sort(
    (a, b) => b.modelCount - a.modelCount || a.topic.localeCompare(b.topic, 'ja'),
  );
  const promoted = sorted.filter((s) => s.modelCount >= 2);
  const single = sorted.filter((s) => s.modelCount === 1);

  let md = '# 3モデル交差検証レポート\n\n';
  md +=
    '要件3.2-2: Claude/ChatGPT/Geminiのログから抽出したトピックのうち、2モデル以上で共通して観察される' +
    'ものだけをペルソナカーネルに昇格させる。単一モデルにのみ現れるパターンは「そのモデルへの適応」と疑う。\n\n';

  md += '| 項目 | 件数 |\n|---|---|\n';
  md += `| トピック総数 | ${summary.totalTopics} |\n`;
  md += `| カーネル昇格候補（2モデル以上） | ${summary.promotedCount} |\n`;
  md += `| 単一モデルのみ（適応疑い） | ${summary.singleModelCount} |\n`;
  md += `| 正典との突き合わせ対象 | ${summary.crossrefCount} |\n\n`;

  md += '## カーネル昇格候補（2モデル以上に出現）\n\n';
  if (promoted.length === 0) {
    md += '（該当トピックはありません）\n\n';
  } else {
    for (const s of promoted) {
      md += `### ${s.topic}\n\n`;
      const counts = [...s.fragmentsByModel.entries()].map(([model, frags]) => `${model}: ${frags.length}件`);
      md += `モデル別断片数: ${counts.join(' / ')}\n\n`;
      for (const [model, frags] of s.fragmentsByModel) {
        const rep = pickRepresentative(frags);
        md += `- **${model}** 代表: 「${excerpt(rep.text)}」 [${rep.origin}]\n`;
      }
      md += '\n';
    }
  }

  md += '## 単一モデルのみ（適応疑い）\n\n';
  if (single.length === 0) {
    md += '（該当トピックはありません）\n\n';
  } else {
    for (const s of single) {
      const [[model, frags]] = [...s.fragmentsByModel.entries()];
      const rep = pickRepresentative(frags);
      md += `- **${s.topic}**（${model}のみ、${frags.length}件）代表: 「${excerpt(rep.text)}」 [${rep.origin}]\n`;
    }
    md += '\n';
  }

  md += '## 正典との突き合わせ対象\n\n';
  md +=
    'appの断片（正典）と同トピックのAIログ断片が両方存在するトピック。実際の矛盾判定は05_kernel_draftの' +
    'LLMと本人が行うため、ここでは機械的な列挙のみを行う。\n\n';
  if (crossref.length === 0) {
    md += '（該当トピックはありません）\n';
  } else {
    md += '| トピック | appの断片数 | AIログの断片数 |\n|---|---|---|\n';
    for (const c of crossref) {
      md += `| ${c.topic} | ${c.appCount} | ${c.aiLogCount} |\n`;
    }
  }

  return `${md.trimEnd()}\n`;
}

// -----------------------------------------------------------------------------
// ディレクトリ再生成
// -----------------------------------------------------------------------------

/** materials 出力先の既存ファイルを全て削除する（無ければ作成）。既存ファイルは全再生成の方針。 */
export function resetMaterialsDir(dir: string): void {
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      rmSync(join(dir, entry), { recursive: true, force: true });
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }
}

// -----------------------------------------------------------------------------
// CLI エントリポイント
// -----------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('04_integrate: 開始');

  const raw = loadTaggedFragments();
  const { kept, excludedCount } = filterAnonymized(raw);
  if (excludedCount > 0) {
    console.warn(`⚠ anonymized=false の断片 ${excludedCount} 件を除外しました（02_anonymize未通過）。`);
  }
  if (kept.length === 0) {
    console.warn('⚠ 対象断片が0件です。03_tag の出力を確認してください。');
  }

  resetMaterialsDir(PIPELINE_PATHS.materials);

  const thinkingDir = join(PIPELINE_PATHS.materials, 'thinking');
  mkdirSync(thinkingDir, { recursive: true });
  const thinkingFiles = buildThinkingTopicFiles(kept);
  for (const [filename, content] of thinkingFiles) {
    writeFileSync(join(thinkingDir, filename), content, 'utf8');
  }

  writeFileSync(join(PIPELINE_PATHS.materials, 'style_samples.md'), buildStyleSamplesMd(kept), 'utf8');
  writeFileSync(join(PIPELINE_PATHS.materials, 'facts_candidates.md'), buildFactsCandidatesMd(kept), 'utf8');

  const byTopic = groupAiLogFragmentsByTopic(kept);
  const stats = computeTopicModelStats(byTopic);
  const crossref = findCanonicalCrossrefTopics(kept, stats);
  writeFileSync(PIPELINE_PATHS.crossModelReport, buildCrossModelReportMd(stats, crossref), 'utf8');

  const generatedFiles = [
    ...[...thinkingFiles.keys()].map((f) => `thinking/${f}`),
    'style_samples.md',
    'facts_candidates.md',
    'cross-model-report.md',
  ].sort((a, b) => a.localeCompare(b, 'ja'));

  const summary = summarizeFragments(kept);
  writeFileSync(join(PIPELINE_PATHS.materials, 'INDEX.md'), buildIndexMd(summary, generatedFiles), 'utf8');

  console.log(`✔ 完了。断片 ${kept.length} 件を ${PIPELINE_PATHS.materials} へ振り分けました。`);
  console.log(
    `  交差検証: トピック総数${stats.length} / 昇格候補${stats.filter((s) => s.modelCount >= 2).length} / ` +
      `適応疑い${stats.filter((s) => s.modelCount === 1).length} / 突き合わせ対象${crossref.length}`,
  );
}

// import.meta.url はパスをURLエンコードするため、process.argv[1]（生パス）と直接比較せず
// fileURLToPath で両者をファイルシステムパスに揃えてから比較する
// （日本語ディレクトリ名（本リポジトリの "青松clone" 等）を含むパスでの誤判定を避けるため）。
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().catch((err) => {
    console.error('\n✖ 04_integrate 失敗:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
