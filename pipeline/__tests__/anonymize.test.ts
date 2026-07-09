import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyAnonymization,
  detectFragments,
  detectInFragment,
  isReportFresh,
  loadNgWords,
  main,
  parseArgs,
  parseNgWords,
} from '../scripts/02_anonymize';
import { PIPELINE_PATHS, readFragmentsJsonl, writeFragmentsJsonl, type Fragment } from '../lib/fragment';

// -----------------------------------------------------------------------------
// fixtures（chdir する前に絶対パスで読み込んでおく）
// -----------------------------------------------------------------------------
const FIXTURE_RAW = fileURLToPath(new URL('./fixtures/anonymize/fragments_raw.jsonl', import.meta.url));
const FIXTURE_NG = fileURLToPath(new URL('./fixtures/anonymize/ng-words.txt', import.meta.url));

const RAW_FRAGMENTS: Fragment[] = readFragmentsJsonl(FIXTURE_RAW);
const NG_WORDS = loadNgWords(FIXTURE_NG).words;

const byId = (id: string) => {
  const f = RAW_FRAGMENTS.find((x) => x.id === id);
  if (!f) throw new Error(`fixture 断片が見つからない: ${id}`);
  return f;
};

// 主要な断片の役割
const DICT_ID = 'frg_claude_000001'; // 「架空太郎」= 辞書ヒット
const HONORIFIC_ID = 'frg_chatgpt_000001'; // 「テスト花子さん」+ 文脈語（成績/指導）
const HONORIFIC_ONLY_ID = 'frg_note_000001'; // 「田中さん」だが文脈語なし → 非検出
const CLASS_ID = 'frg_work_000001'; // 「3年2組」「出席番号」
const CONTACT_ID = 'frg_gemini_000001'; // メール・電話
const CLEAN_ID = 'frg_app_000001'; // クリーン

describe('NG辞書のパース', () => {
  it('# コメント行と空行を無視して1行1語で読む', () => {
    const words = parseNgWords('# コメント\n\n架空太郎\n  架空商業高校  \n#末尾コメント');
    expect(words).toEqual(['架空太郎', '架空商業高校']);
  });

  it('辞書ファイルが無ければ dictMissing=true', () => {
    const load = loadNgWords(join(tmpdir(), 'does-not-exist-ng.txt'));
    expect(load.dictMissing).toBe(true);
    expect(load.words).toEqual([]);
  });
});

describe('① NG辞書検出', () => {
  it('辞書語を部分文字列一致で検出する', () => {
    const matches = detectInFragment(byId(DICT_ID), NG_WORDS);
    const dict = matches.filter((m) => m.detector === 'dict');
    expect(dict.length).toBeGreaterThan(0);
    expect(dict[0].matchText).toBe('架空太郎');
  });
});

describe('② 敬称+文脈語の共起検出', () => {
  it('敬称+人名が文脈語と共起したら検出する', () => {
    const matches = detectInFragment(byId(HONORIFIC_ID), NG_WORDS);
    const hc = matches.filter((m) => m.detector === 'honorific-context');
    expect(hc.length).toBeGreaterThan(0);
    expect(hc[0].matchText).toContain('さん');
    expect(hc[0].note).toBeTruthy();
  });

  it('敬称のみで文脈語が無ければ検出しない', () => {
    const matches = detectInFragment(byId(HONORIFIC_ONLY_ID), NG_WORDS);
    expect(matches.filter((m) => m.detector === 'honorific-context')).toHaveLength(0);
    // この断片自体がまったく検出されないこと
    expect(matches).toHaveLength(0);
  });
});

describe('③ 生徒特定パターン', () => {
  it('N年M組 と 出席番号 を検出する', () => {
    const matches = detectInFragment(byId(CLASS_ID), NG_WORDS);
    const ids = matches.filter((m) => m.detector === 'student-id').map((m) => m.matchText);
    expect(ids).toContain('3年2組');
    expect(ids.some((t) => t.startsWith('出席番号'))).toBe(true);
  });
});

describe('連絡先パターン', () => {
  it('メールと電話番号を検出する', () => {
    const matches = detectInFragment(byId(CONTACT_ID), NG_WORDS);
    const contact = matches.filter((m) => m.detector === 'contact').map((m) => m.matchText);
    expect(contact).toContain('test@example.com');
    expect(contact).toContain('090-1234-5678');
  });
});

describe('⑥ 辞書なしでも汎用パターンは動く', () => {
  it('NG辞書が空でも敬称+文脈語 / 生徒特定 / 連絡先 は検出される', () => {
    const detections = detectFragments(RAW_FRAGMENTS, []); // 辞書ゼロ
    const detectedIds = new Set(detections.map((d) => d.fragment.id));
    expect(detectedIds.has(HONORIFIC_ID)).toBe(true);
    expect(detectedIds.has(CLASS_ID)).toBe(true);
    expect(detectedIds.has(CONTACT_ID)).toBe(true);
    // クリーン断片と敬称のみ断片は検出されない
    expect(detectedIds.has(CLEAN_ID)).toBe(false);
    expect(detectedIds.has(HONORIFIC_ONLY_ID)).toBe(false);
    // 辞書無しなので辞書ヒット断片は（辞書由来では）検出されない
    expect(detectedIds.has(DICT_ID)).toBe(false);
  });
});

describe('④ --apply で検出断片が削除され、残存が anonymized=true', () => {
  it('検出断片を削除しクリーン断片に anonymized=true を付ける', () => {
    const detections = detectFragments(RAW_FRAGMENTS, NG_WORDS);
    const { clean, deletedIds } = applyAnonymization(RAW_FRAGMENTS, detections, new Set());
    const cleanIds = new Set(clean.map((f) => f.id));

    // 検出断片は全て削除
    expect(deletedIds).toContain(DICT_ID);
    expect(deletedIds).toContain(HONORIFIC_ID);
    expect(deletedIds).toContain(CLASS_ID);
    expect(deletedIds).toContain(CONTACT_ID);
    // クリーン断片は残り、anonymized=true
    expect(cleanIds.has(CLEAN_ID)).toBe(true);
    expect(clean.every((f) => f.anonymized === true)).toBe(true);
    // 敬称のみ断片も（非検出なので）残る
    expect(cleanIds.has(HONORIFIC_ONLY_ID)).toBe(true);
  });
});

describe('⑤ --allow で指定断片が残る', () => {
  it('allow された検出断片は削除されず anonymized=true で残る', () => {
    const detections = detectFragments(RAW_FRAGMENTS, NG_WORDS);
    const { clean, deletedIds, allowedIds } = applyAnonymization(
      RAW_FRAGMENTS,
      detections,
      new Set([HONORIFIC_ID]),
    );
    const cleanIds = new Set(clean.map((f) => f.id));
    expect(allowedIds).toContain(HONORIFIC_ID);
    expect(deletedIds).not.toContain(HONORIFIC_ID);
    expect(cleanIds.has(HONORIFIC_ID)).toBe(true);
    expect(clean.find((f) => f.id === HONORIFIC_ID)?.anonymized).toBe(true);
    // 他の検出断片は依然削除
    expect(deletedIds).toContain(DICT_ID);
  });
});

describe('parseArgs', () => {
  it('--apply と --allow（スペース区切り値 / = 記法）を解釈する', () => {
    expect(parseArgs(['--apply'])).toEqual({ apply: true, allow: [] });
    expect(parseArgs(['--apply', '--allow', 'a,b , c'])).toEqual({
      apply: true,
      allow: ['a', 'b', 'c'],
    });
    expect(parseArgs(['--allow=x,y'])).toEqual({ apply: false, allow: ['x', 'y'] });
  });
});

// -----------------------------------------------------------------------------
// ⑦ レポート未生成での apply 拒否（isReportFresh + main の統合）
// -----------------------------------------------------------------------------
describe('⑦ レポート鮮度チェック / apply 拒否', () => {
  it('isReportFresh: レポート無し→false、古い→false、新しい→true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anon-fresh-'));
    try {
      const raw = join(dir, 'raw.jsonl');
      const rep = join(dir, 'report.md');
      writeFileSync(raw, 'x');
      expect(isReportFresh(rep, raw)).toBe(false); // レポート無し

      writeFileSync(rep, 'y');
      // レポートを raw より古くする
      const old = Date.now() / 1000 - 100;
      utimesSync(rep, old, old);
      expect(isReportFresh(rep, raw)).toBe(false);

      // レポートを raw より新しくする
      const now = Date.now() / 1000 + 100;
      utimesSync(rep, now, now);
      expect(isReportFresh(rep, raw)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('main を一時作業ディレクトリで実行', () => {
    let dir: string;
    let prevCwd: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'anon-main-'));
      prevCwd = process.cwd();
      process.chdir(dir);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      // 相対パス PIPELINE_PATHS.raw に fixture を配置
      writeFragmentsJsonl(PIPELINE_PATHS.raw, RAW_FRAGMENTS);
      mkdirSync('pipeline/private', { recursive: true });
      writeFileSync(PIPELINE_PATHS.ngWords, NG_WORDS.map((w) => w).join('\n'));
      process.exitCode = 0;
    });

    afterEach(() => {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
      process.exitCode = 0;
    });

    it('レポート未生成での --apply は拒否され clean を書かない', async () => {
      const res = await main(['--apply']);
      expect(res.refused).toBe(true);
      expect(res.ok).toBe(false);
      expect(existsSync(PIPELINE_PATHS.clean)).toBe(false);
    });

    it('レポート生成→apply で clean が書かれ、残存が anonymized=true', async () => {
      const report = await main([]);
      expect(report.mode).toBe('report');
      expect(existsSync(PIPELINE_PATHS.anonymizeReport)).toBe(true);
      expect(report.detectedFragments).toBeGreaterThan(0);

      // レポートが raw と同時刻以降であることを保証（同一msでも >= で通す設計）
      expect(
        statSync(PIPELINE_PATHS.anonymizeReport).mtimeMs >= statSync(PIPELINE_PATHS.raw).mtimeMs,
      ).toBe(true);

      const applied = await main(['--apply']);
      expect(applied.refused).toBeFalsy();
      expect(applied.ok).toBe(true);
      expect(applied.deleted).toBeGreaterThan(0);

      const clean = readFragmentsJsonl(PIPELINE_PATHS.clean);
      expect(clean.length).toBe(applied.remaining);
      expect(clean.every((f) => f.anonymized === true)).toBe(true);
      // クリーン断片は残る
      expect(clean.some((f) => f.id === CLEAN_ID)).toBe(true);
    });

    it('辞書未整備でも汎用パターンでレポートが出る', async () => {
      rmSync(PIPELINE_PATHS.ngWords, { force: true });
      const report = await main([]);
      expect(report.dictMissing).toBe(true);
      expect(report.detectedFragments).toBeGreaterThan(0);
    });
  });
});
