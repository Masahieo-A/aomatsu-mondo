// =============================================================================
// 05_kernel_draft  —  ペルソナカーネル / スタイルガイド 更新草案の生成（月次）
//
//   入力:
//     - corpus/materials/ 配下の md（04の出力。無ければ「先に04を実行」エラー）
//       ※合計10万字で先頭から打ち切り、打ち切った旨を草案冒頭に注記
//     - PIPELINE_PATHS.crossModelReport（3モデル交差検証レポート）
//     - 現行ドキュメント（kernel: persona-kernel.md / style: style-guide.md）
//   出力:
//     - kernel → pipeline/work/kernel_draft.md
//     - style  → pipeline/work/style_draft.md
//     （corpus は直接書き換えない。本人レビュー用の草案のみ）
//   モデル: 既定 claude-fable-5（月次1回・品質最優先）
//
//   CLI: npx tsx pipeline/scripts/05_kernel_draft.ts [--target kernel|style] [--model <id>]
// =============================================================================
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PIPELINE_PATHS } from '../lib/fragment';
import {
  KERNEL_DRAFT_SYSTEM_PROMPT,
  STYLE_DRAFT_SYSTEM_PROMPT,
  buildDraftUserPrompt,
} from '../lib/prompts';
import { createClaudeClient, type ClaudeClient } from '../lib/claude-api';
import { createGeminiClient } from '../lib/gemini-api';

const DEFAULT_MODEL = 'claude-fable-5';

export type Provider = 'gemini' | 'claude';
/** 既定はGemini（ユーザー決定 2026-07-10）。--provider claude で切替可 */
export const DEFAULT_PROVIDER: Provider = 'gemini';
export const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  // 3.5-flashは無料枠対象。草案の質を上げたい月は --model gemini-3.1-pro（有料）を指定
  gemini: 'gemini-3.5-flash',
  claude: DEFAULT_MODEL,
};
const MATERIALS_CHAR_BUDGET = 100_000; // materials 合計の上限（先頭から打ち切り）
const DRAFT_MAX_TOKENS = 32_000; // 草案は長くなり得るので十分大きく

type Target = 'kernel' | 'style';

const STYLE_DRAFT_PATH = 'pipeline/work/style_draft.md';

export interface RunDraftDeps {
  client: ClaudeClient;
  target: Target;
  model?: string;
  materialsDir?: string;
  crossModelReportPath?: string;
  currentDocPath?: string;
  outPath?: string;
  logger?: { log: (m: string) => void };
}

export interface RunDraftResult {
  outPath: string;
  truncated: boolean;
  materialsChars: number;
}

// -----------------------------------------------------------------------------
// materials/ の md を先頭から合計 budget 字まで集約
// -----------------------------------------------------------------------------
export function gatherMaterials(
  materialsDir: string,
  budget: number,
): { digest: string; truncated: boolean; totalChars: number } {
  const files = readdirSync(materialsDir)
    .filter((n) => n.toLowerCase().endsWith('.md'))
    // 交差検証レポートは別入力なので materials 集約からは除外
    .filter((n) => join(materialsDir, n) !== PIPELINE_PATHS.crossModelReport)
    .sort();

  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  for (const name of files) {
    if (used >= budget) {
      truncated = true;
      break;
    }
    const full = readFileSync(join(materialsDir, name), 'utf8');
    const remaining = budget - used;
    const slice = full.length > remaining ? full.slice(0, remaining) : full;
    if (full.length > remaining) truncated = true;
    parts.push(`### ${name}\n\n${slice}`);
    used += slice.length;
  }

  return { digest: parts.join('\n\n'), truncated, totalChars: used };
}

// -----------------------------------------------------------------------------
// 本体
// -----------------------------------------------------------------------------
export async function runDraft(deps: RunDraftDeps): Promise<RunDraftResult> {
  const model = deps.model ?? DEFAULT_MODEL;
  const materialsDir = deps.materialsDir ?? PIPELINE_PATHS.materials;
  const crossModelReportPath = deps.crossModelReportPath ?? PIPELINE_PATHS.crossModelReport;
  const currentDocPath =
    deps.currentDocPath ?? (deps.target === 'kernel' ? PIPELINE_PATHS.kernel : PIPELINE_PATHS.styleGuide);
  const outPath = deps.outPath ?? (deps.target === 'kernel' ? PIPELINE_PATHS.kernelDraft : STYLE_DRAFT_PATH);
  const log = deps.logger ?? { log: console.log };

  // materials/ が無い or md が1件も無ければ「先に04を実行」
  const hasMaterials =
    existsSync(materialsDir) &&
    readdirSync(materialsDir).some((n) => n.toLowerCase().endsWith('.md'));
  if (!hasMaterials) {
    throw new Error(
      `${materialsDir} に素材(md)が見つかりません。先に 04_integrate を実行して ` +
        `${PIPELINE_PATHS.materials} を生成してください。`,
    );
  }

  const { digest, truncated, totalChars } = gatherMaterials(materialsDir, MATERIALS_CHAR_BUDGET);
  const crossModelReport = existsSync(crossModelReportPath)
    ? readFileSync(crossModelReportPath, 'utf8')
    : '（交差検証レポートは未生成です）';
  const currentDoc = existsSync(currentDocPath)
    ? readFileSync(currentDocPath, 'utf8')
    : '（現行ドキュメントは未作成です。新規に骨子を提案してください）';

  const system = deps.target === 'kernel' ? KERNEL_DRAFT_SYSTEM_PROMPT : STYLE_DRAFT_SYSTEM_PROMPT;
  const user = buildDraftUserPrompt({ currentDoc, materialsDigest: digest, crossModelReport });

  log.log(
    `草案生成開始: 対象 ${deps.target} / モデル ${model} / materials ${totalChars.toLocaleString()} 字` +
      (truncated ? '（上限で打ち切りあり）' : ''),
  );

  const res = await deps.client.complete({ model, system, user, maxTokens: DRAFT_MAX_TOKENS });

  const header = truncated
    ? `> ⚠ 注記: コーパス素材が大きいため、各mdの先頭から合計 ${MATERIALS_CHAR_BUDGET.toLocaleString()} 字で打ち切って生成しています。全量ではありません。\n\n`
    : '';

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, header + res.text + '\n');

  return { outPath, truncated, materialsChars: totalChars };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
function parseCliArgs(argv: string[]): { target: Target; model?: string; provider: Provider } {
  let target: Target = 'kernel';
  let model: string | undefined;
  let provider: Provider = DEFAULT_PROVIDER;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') {
      const v = argv[++i];
      if (v === 'kernel' || v === 'style') target = v;
      else throw new Error(`--target は kernel または style を指定してください（受領: ${v}）`);
    } else if (a === '--model') {
      model = argv[++i];
    } else if (a === '--provider') {
      const v = argv[++i];
      if (v === 'gemini' || v === 'claude') provider = v;
      else throw new Error(`--provider は gemini または claude を指定してください（受領: ${v}）`);
    }
  }
  return { target, model, provider };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const client = args.provider === 'claude' ? createClaudeClient() : createGeminiClient();
  const result = await runDraft({
    client,
    target: args.target,
    model: args.model ?? PROVIDER_DEFAULT_MODEL[args.provider],
  });

  console.log(`\n✔ 草案を書き出しました: ${result.outPath}`);
  if (result.truncated) {
    console.log('  （materials が大きいため先頭打ち切りで生成。草案冒頭に注記あり）');
  }
  console.log(`  ${client.formatUsage()}`);
  console.log('  ※これは本人レビュー用の草案です。corpus は自動では書き換えていません。');
}

if (process.argv[1] && process.argv[1].endsWith('05_kernel_draft.ts')) {
  main().catch((err) => {
    console.error('\n✖ 05_kernel_draft でエラー:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
