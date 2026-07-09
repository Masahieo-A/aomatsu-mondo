// =============================================================================
// 青松AI コーパスパイプライン  02_anonymize — 匿名化（要件3.3・6. 最重要の安全工程）
//
//   生徒氏名・成績・進路情報・同僚実名・学校機微情報を「機械 + 目視」の二段階で除去する。
//   生徒情報は仮名化ではなく【削除】を原則とする（要件3.3）。
//
//   使い方:
//     npx tsx pipeline/scripts/02_anonymize.ts
//         → 検出のみ。work/anonymize_report.md を生成（本人が目視レビューする）
//     npx tsx pipeline/scripts/02_anonymize.ts --apply
//         → レビュー済みを前提に、検出断片を削除して work/fragments_clean.jsonl を出力
//           （レポート未生成 or raw より古い場合は拒否 = 目視レビューを強制する仕組み）
//     npx tsx pipeline/scripts/02_anonymize.ts --apply --allow frg_xxx_000001,frg_yyy_000002
//         → レビューの結果「誤検出なので残す」と本人が判断した断片idを削除対象から除外
//
//   検出は「見逃しより誤検出に倒す」方針（過剰検出を許容し、最終判断は人間に委ねる）。
// =============================================================================
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type Fragment,
  PIPELINE_PATHS,
  readFragmentsJsonl,
  writeFragmentsJsonl,
} from '../lib/fragment';

// -----------------------------------------------------------------------------
// 検出器の定義
// -----------------------------------------------------------------------------
export type DetectorKind = 'dict' | 'honorific-context' | 'student-id' | 'contact';

export const DETECTOR_LABEL: Record<DetectorKind, string> = {
  dict: 'NG辞書',
  'honorific-context': '敬称+文脈語共起',
  'student-id': '生徒特定パターン',
  contact: '連絡先(メール/電話)',
};

/**
 * 教育文脈語。人名+敬称がこれらと同一断片内に共起したとき「生徒・保護者・同僚の
 * 機微情報の可能性が高い」と判断する（敬称のみ・日常会話は検出しない）。
 */
export const CONTEXT_WORDS = [
  '成績', '進路', '偏差値', '評定', '内申', '指導', '保護者', '欠席', '推薦',
  '志望', '合格', '不合格', '担任', '面談', '三者面談', '生徒', '受験', '退学',
  '停学', '不登校', '特別支援', 'いじめ', '課題提出', '欠点', '補習',
] as const;

/** 人名らしき語 + 敬称。敬称は長いものを先に並べる（最長一致を助ける） */
const HONORIFIC_RE = /[一-龥々〆ヶァ-ヶーぁ-ん]{1,5}(?:先生|ちゃん|くん|さん|君)/g;

/** 「N年M組」（全角/漢数字も許容） */
const CLASS_RE = /[0-9０-９一二三四五六七八九十]+年[0-9０-９一二三四五六七八九十]+組/g;
/** 出席番号 + 続く番号 */
const ATTENDANCE_RE = /出席番号[０-９0-9一二三四五六七八九十]*/g;

/** メールアドレスらしき文字列 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 電話番号らしき文字列（ハイフン区切り or 連続10〜11桁） */
const PHONE_RE = /0\d{1,4}-\d{1,4}-\d{3,4}|0\d{9,10}/g;

// -----------------------------------------------------------------------------
// 検出結果の型
// -----------------------------------------------------------------------------
export interface DetectionMatch {
  detector: DetectorKind;
  /** 検出された文字列そのもの */
  matchText: string;
  /** fragment.text 内の開始位置 */
  index: number;
  /** 補足（共起した文脈語など。レポート用） */
  note?: string;
}

export interface FragmentDetection {
  fragment: Fragment;
  matches: DetectionMatch[];
}

// -----------------------------------------------------------------------------
// NG辞書の読み込み
// -----------------------------------------------------------------------------
/** 1行1語。# で始まる行と空行は無視。前後空白は除去 */
export function parseNgWords(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

export interface NgWordsLoad {
  words: string[];
  /** 辞書ファイルが存在しない、または有効語が0件（＝未整備） */
  dictMissing: boolean;
}

export function loadNgWords(path: string): NgWordsLoad {
  if (!existsSync(path)) return { words: [], dictMissing: true };
  const words = parseNgWords(readFileSync(path, 'utf8'));
  return { words, dictMissing: words.length === 0 };
}

// -----------------------------------------------------------------------------
// 単一断片の検出
// -----------------------------------------------------------------------------
export function detectInFragment(fragment: Fragment, ngWords: string[]): DetectionMatch[] {
  const text = fragment.text;
  const matches: DetectionMatch[] = [];

  // (1) NG辞書: 部分文字列一致（日本語名は活用しないため完全一致にしない）
  for (const word of ngWords) {
    if (word.length === 0) continue;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(word, from);
      if (idx === -1) break;
      matches.push({ detector: 'dict', matchText: word, index: idx });
      from = idx + word.length;
    }
  }

  // (2) 汎用パターン: 人名+敬称 が 教育文脈語 と同一断片内に共起したときのみ検出
  const foundContext = CONTEXT_WORDS.filter((w) => text.includes(w));
  if (foundContext.length > 0) {
    for (const m of text.matchAll(HONORIFIC_RE)) {
      matches.push({
        detector: 'honorific-context',
        matchText: m[0],
        index: m.index ?? 0,
        note: `文脈語: ${foundContext.join('・')}`,
      });
    }
  }

  // (3) 生徒特定パターン: N年M組 / 出席番号
  for (const re of [CLASS_RE, ATTENDANCE_RE]) {
    for (const m of text.matchAll(re)) {
      matches.push({ detector: 'student-id', matchText: m[0], index: m.index ?? 0 });
    }
  }

  // (4) 連絡先: メール / 電話
  for (const re of [EMAIL_RE, PHONE_RE]) {
    for (const m of text.matchAll(re)) {
      matches.push({ detector: 'contact', matchText: m[0], index: m.index ?? 0 });
    }
  }

  matches.sort((a, b) => a.index - b.index);
  return matches;
}

/** 全断片を検出し、1件以上ヒットした断片のみ返す */
export function detectFragments(fragments: Fragment[], ngWords: string[]): FragmentDetection[] {
  const out: FragmentDetection[] = [];
  for (const fragment of fragments) {
    const matches = detectInFragment(fragment, ngWords);
    if (matches.length > 0) out.push({ fragment, matches });
  }
  return out;
}

/** 検出器ごとのマッチ件数の内訳 */
export function detectorBreakdown(detections: FragmentDetection[]): Record<DetectorKind, number> {
  const b: Record<DetectorKind, number> = {
    dict: 0,
    'honorific-context': 0,
    'student-id': 0,
    contact: 0,
  };
  for (const d of detections) for (const m of d.matches) b[m.detector] += 1;
  return b;
}

// -----------------------------------------------------------------------------
// レポート生成
// -----------------------------------------------------------------------------
/** 検出語の前後 radius 字を抜き出し、検出語を **太字** で囲む（改行は空白に正規化） */
export function extractContext(text: string, index: number, matchText: string, radius = 80): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchText.length + radius);
  const norm = (s: string) => s.replace(/\r?\n/g, ' ');
  const before = norm(text.slice(start, index));
  const after = norm(text.slice(index + matchText.length, end));
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${before}**${norm(matchText)}**${after}${suffix}`;
}

export function buildReport(
  fragments: Fragment[],
  detections: FragmentDetection[],
  opts: { dictMissing: boolean },
): string {
  const breakdown = detectorBreakdown(detections);
  const lines: string[] = [];

  lines.push('# 匿名化検出レポート（02_anonymize）');
  lines.push('');
  lines.push(`生成日時: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(
    '> このレポートは「機械検出」の結果です。**必ず本人が目視レビュー**し、削除して良いか確認してください。',
  );
  lines.push('> 誤検出（残したい断片）があれば `--apply --allow <id,...>` でその id を除外できます。');
  lines.push('');

  if (opts.dictMissing) {
    lines.push(
      '⚠️ **NG辞書が未整備です**（`pipeline/private/ng-words.txt` が存在しないか空）。',
    );
    lines.push(
      '　生徒名・同僚名・学校固有名は辞書に依存するため、汎用パターンのみでは取りこぼす恐れがあります。',
    );
    lines.push('　辞書を整備してから再実行することを強く推奨します。');
    lines.push('');
  }

  lines.push('## サマリ');
  lines.push('');
  lines.push(`- 総断片数: ${fragments.length}`);
  lines.push(`- 検出断片数: ${detections.length}`);
  lines.push('- 検出器別内訳（マッチ件数）:');
  lines.push(`  - ${DETECTOR_LABEL.dict}: ${breakdown.dict}`);
  lines.push(`  - ${DETECTOR_LABEL['honorific-context']}: ${breakdown['honorific-context']}`);
  lines.push(`  - ${DETECTOR_LABEL['student-id']}: ${breakdown['student-id']}`);
  lines.push(`  - ${DETECTOR_LABEL.contact}: ${breakdown.contact}`);
  lines.push('');

  lines.push('## 検出断片一覧');
  lines.push('');
  if (detections.length === 0) {
    lines.push('（検出なし）');
    lines.push('');
  }

  for (const { fragment, matches } of detections) {
    lines.push(`### ${fragment.id}`);
    lines.push('');
    lines.push(`- origin: \`${fragment.origin}\``);
    lines.push(`- source: ${fragment.source}`);
    const summary = matches
      .map((m) => {
        const note = m.note ? `（${m.note}）` : '';
        return `[${DETECTOR_LABEL[m.detector]}]「${m.matchText}」${note}`;
      })
      .join(' / ');
    lines.push(`- 検出: ${summary}`);
    lines.push('- 該当箇所:');
    matches.forEach((m, i) => {
      lines.push(`  ${i + 1}. ${extractContext(fragment.text, m.index, m.matchText)}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// --apply（確定）
// -----------------------------------------------------------------------------
/**
 * 検出断片を削除（allowIds は残す）。残存断片は anonymized=true にして返す。
 * 生徒情報は仮名化せず削除が原則（要件3.3）。
 */
export function applyAnonymization(
  fragments: Fragment[],
  detections: FragmentDetection[],
  allowIds: Set<string>,
): { clean: Fragment[]; deletedIds: string[]; allowedIds: string[] } {
  const detectedIds = new Set(detections.map((d) => d.fragment.id));
  const deletedIds: string[] = [];
  const allowedIds: string[] = [];
  const clean: Fragment[] = [];

  for (const f of fragments) {
    if (detectedIds.has(f.id)) {
      if (allowIds.has(f.id)) {
        allowedIds.push(f.id);
        clean.push({ ...f, anonymized: true });
      } else {
        deletedIds.push(f.id);
      }
      continue;
    }
    clean.push({ ...f, anonymized: true });
  }
  return { clean, deletedIds, allowedIds };
}

/**
 * レポートが存在し、かつ raw と NG辞書の両方と同時刻以降か。
 * 辞書もチェックする理由: apply は検出を再実行するため、レポート生成後に辞書を
 * 編集すると「目視レビューした内容」と「実際に削除される内容」がズレる。
 * 辞書を編集したら必ずレポートを再生成させる。
 */
export function isReportFresh(reportPath: string, rawPath: string, ngWordsPath?: string): boolean {
  if (!existsSync(reportPath) || !existsSync(rawPath)) return false;
  const reportMtime = statSync(reportPath).mtimeMs;
  if (reportMtime < statSync(rawPath).mtimeMs) return false;
  if (ngWordsPath && existsSync(ngWordsPath) && reportMtime < statSync(ngWordsPath).mtimeMs) {
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// CLI 引数
// -----------------------------------------------------------------------------
export interface ParsedArgs {
  apply: boolean;
  allow: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const splitIds = (v: string) => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  let apply = false;
  const allow: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--allow') allow.push(...splitIds(argv[++i] ?? ''));
    else if (a.startsWith('--allow=')) allow.push(...splitIds(a.slice('--allow='.length)));
  }
  return { apply, allow };
}

// -----------------------------------------------------------------------------
// メイン
// -----------------------------------------------------------------------------
export interface RunResult {
  mode: 'report' | 'apply';
  ok: boolean;
  refused?: boolean;
  reason?: string;
  totalFragments: number;
  detectedFragments: number;
  breakdown: Record<DetectorKind, number>;
  dictMissing: boolean;
  deleted?: number;
  remaining?: number;
  allowed?: number;
}

export async function main(argv: string[]): Promise<RunResult> {
  const { apply, allow } = parseArgs(argv);
  const rawPath = PIPELINE_PATHS.raw;

  if (!existsSync(rawPath)) {
    const reason = `入力が見つかりません: ${rawPath}（先に 01_extract を実行してください）`;
    console.error(`✗ ${reason}`);
    process.exitCode = 1;
    return {
      mode: apply ? 'apply' : 'report',
      ok: false,
      refused: true,
      reason,
      totalFragments: 0,
      detectedFragments: 0,
      breakdown: detectorBreakdown([]),
      dictMissing: true,
    };
  }

  const fragments = readFragmentsJsonl(rawPath);
  const { words: ngWords, dictMissing } = loadNgWords(PIPELINE_PATHS.ngWords);
  if (dictMissing) {
    console.warn(
      `⚠ NG辞書が未整備です（${PIPELINE_PATHS.ngWords}）。汎用パターンのみで検査を続行します。`,
    );
  }

  const detections = detectFragments(fragments, ngWords);
  const breakdown = detectorBreakdown(detections);

  if (!apply) {
    // レポートモード
    const report = buildReport(fragments, detections, { dictMissing });
    mkdirSync(dirname(PIPELINE_PATHS.anonymizeReport), { recursive: true });
    writeFileSync(PIPELINE_PATHS.anonymizeReport, report);
    console.log(
      `検出: ${detections.length}/${fragments.length} 断片。レポートを出力しました: ${PIPELINE_PATHS.anonymizeReport}`,
    );
    console.log('→ 内容を目視レビューし、問題なければ `--apply` で確定してください。');
    return {
      mode: 'report',
      ok: true,
      totalFragments: fragments.length,
      detectedFragments: detections.length,
      breakdown,
      dictMissing,
    };
  }

  // applyモード: レポート未生成 or raw/NG辞書 より古い場合は拒否（目視レビューを強制）
  if (!isReportFresh(PIPELINE_PATHS.anonymizeReport, rawPath, PIPELINE_PATHS.ngWords)) {
    const reason = existsSync(PIPELINE_PATHS.anonymizeReport)
      ? 'レポートより後に raw または NG辞書が更新されています。'
      : 'レポートが未生成です。';
    console.error(
      `✗ 先にレポートを確認してください（${reason}）\n  実行: npx tsx pipeline/scripts/02_anonymize.ts`,
    );
    process.exitCode = 1;
    return {
      mode: 'apply',
      ok: false,
      refused: true,
      reason,
      totalFragments: fragments.length,
      detectedFragments: detections.length,
      breakdown,
      dictMissing,
    };
  }

  const allowSet = new Set(allow);
  const { clean, deletedIds, allowedIds } = applyAnonymization(fragments, detections, allowSet);
  writeFragmentsJsonl(PIPELINE_PATHS.clean, clean);

  console.log('匿名化を適用しました。');
  console.log(`  削除: ${deletedIds.length} 断片（検出）`);
  if (allowedIds.length > 0) {
    console.log(`  許可（残す）: ${allowedIds.length} 断片 → ${allowedIds.join(', ')}`);
  }
  console.log(`  残存: ${clean.length} 断片（anonymized=true）`);
  console.log(`  出力: ${PIPELINE_PATHS.clean}`);

  return {
    mode: 'apply',
    ok: true,
    totalFragments: fragments.length,
    detectedFragments: detections.length,
    breakdown,
    dictMissing,
    deleted: deletedIds.length,
    remaining: clean.length,
    allowed: allowedIds.length,
  };
}

// スクリプトとして直接実行されたときのみ main を起動（テストから import しても走らない）
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
