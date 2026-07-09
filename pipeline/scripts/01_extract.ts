// =============================================================================
// 01_extract  —  6ソース → Fragment 正規化（青松AI コーパスパイプライン P1）
//
//   CLI: npx tsx pipeline/scripts/01_extract.ts --source <name> [path]
//     name = app | chatgpt | claude | gemini | texts | tensaku
//
//   出力 pipeline/work/fragments_raw.jsonl は「マージ書き込み」:
//     同一ソース（origin プレフィクス <source>: ）の既存断片は置き換え、
//     他ソースの断片はそのまま保持する。複数回実行で全ソース分を蓄積できる。
//
//   id は fragmentId(source, seq) で入力順に決定的採番（FragmentSource ごとに1から）。
//   text は「本人の声」のみ（AI応答・システムメッセージは含めない = 要件3.3 前処理）。
//   各社エクスポート形式は変わり得るため防御的にパースし、壊れた断片はスキップして
//   件数を stderr に報告する。
// =============================================================================
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative, basename, extname } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  type Fragment,
  type FragmentSource,
  type FragmentRegister,
  fragmentId,
  writeFragmentsJsonl,
  readFragmentsJsonl,
  PIPELINE_PATHS,
} from '../lib/fragment';
// アプリ側の変換規則を再利用（層マッピング・回答id書式）。選択式の choice→本文変換は
// src/lib/export.ts の toExportRecord と同じ規則を下の buildAppFragments で再現する。
import { CATEGORY_LAYER, type Category } from '../../src/lib/types';
import { formatAnswerId } from '../../src/lib/export';

const ROOT = resolve(__dirname, '..', '..');

// id を除いた断片（採番前）。numberFragments で id を付与する。
export type PartialFragment = Omit<Fragment, 'id'>;

// パーサの返り値: 生成断片と、スキップ件数。
export interface ExtractResult {
  fragments: PartialFragment[];
  skipped: number;
}

// -----------------------------------------------------------------------------
// 共通ヘルパ
// -----------------------------------------------------------------------------

/** 全ソース共通のデフォルト（指定が無いフィールドは null/[]、anonymized=false）。 */
function defaults(): Omit<
  PartialFragment,
  'source' | 'text' | 'origin'
> {
  return {
    layer: null,
    topics: [],
    register: null,
    confidence: null,
    context: null,
    created_at: null,
    anonymized: false,
  };
}

/**
 * AIログの発話スキップ判定。
 *   - 空文字（trim 後）
 *   - 50字未満の定型（相槌）: 「ありがとう」「続けて」「OK」等
 * 学習対象は本人の実質的な発話のみに絞る（要件3.3）。
 */
const BACKCHANNEL_RE =
  /^(ありがとう(ござい(ます|ました))?|thanks?|thank you|続け(て|る)?|続き(を)?(お願い(します)?)?|もっと|ok|okay|了解(です)?|承知(しました)?|はい(お願いします)?|うん|なるほど|いいね|good|great|👍|草|www?)[。！!、,.\s]*$/i;

export function shouldSkipUtterance(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (t.length < 50 && BACKCHANNEL_RE.test(t)) return true;
  return false;
}

/** 直前のAI応答の冒頭120字を context にする（無ければ null）。 */
function contextFrom(prevAssistant: string | null): string | null {
  if (!prevAssistant) return null;
  const t = prevAssistant.trim();
  return t.length === 0 ? null : t.slice(0, 120);
}

/** 未知の形の JSON を防御的に読む。壊れていれば例外（呼び出し側で扱う）。 */
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** ディレクトリ配下を再帰走査し、拡張子に一致するファイルを絶対パスで返す（決定的にソート）。 */
function walkFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) visit(full);
      else if (exts.includes(extname(name).toLowerCase())) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
}

/**
 * PartialFragment 群に id を付与。FragmentSource ごとに 1 から連番（入力順）。
 * texts は note/x/work と複数の FragmentSource を含み得るため source 別に採番する。
 */
export function numberFragments(partials: PartialFragment[]): Fragment[] {
  const counters = new Map<FragmentSource, number>();
  return partials.map((p) => {
    const seq = (counters.get(p.source) ?? 0) + 1;
    counters.set(p.source, seq);
    return { id: fragmentId(p.source, seq), ...p };
  });
}

/**
 * マージ書き込み: 既存断片のうち origin が「<cliSource>:」で始まるものを置き換え、
 * 他ソースの断片は保持する。texts の断片は origin が texts: で始まるため、
 * FragmentSource が note/x/work でも cliSource='texts' で正しく置換される。
 */
export function mergeFragments(
  existing: Fragment[],
  cliSource: string,
  incoming: Fragment[],
): Fragment[] {
  const prefix = `${cliSource}:`;
  const kept = existing.filter((f) => !f.origin.startsWith(prefix));
  return [...kept, ...incoming];
}

// -----------------------------------------------------------------------------
// 1) --source app : Supabase から直接取得
// -----------------------------------------------------------------------------

/** Supabase join を正規化した1行（answers + questions）。 */
export interface AppRow {
  seq: number;
  answer_text: string | null;
  reason_text: string | null;
  choice: 'A' | 'B' | null;
  submitted_at: string | null;
  category: Category;
  body: string;
  body_options: { A: string; B: string } | null;
}

const APP_SELECT =
  'seq, answer_text, reason_text, choice, submitted_at, ' +
  'questions ( category, body, body_options )';

/**
 * AppRow[] → PartialFragment[]（純粋関数。テスト対象の変換規則本体）。
 *   text = 「Q: 質問文\nA: 回答本文\n理由: 理由」（理由は reason_text があれば付加）
 *   選択式（Q1/Q4）は export.ts と同じ「A: 選択肢本文」規則で本文化する。
 */
export function buildAppFragments(rows: AppRow[]): PartialFragment[] {
  return rows.map((r) => {
    // --- export.ts toExportRecord と同一の choice→本文変換規則 ---
    const choiceText =
      r.choice && r.body_options ? `${r.choice}: ${r.body_options[r.choice]}` : r.choice;
    const answerBody = r.answer_text ?? choiceText ?? '';

    let text = `Q: ${r.body}\nA: ${answerBody}`;
    if (r.reason_text && r.reason_text.trim().length > 0) {
      text += `\n理由: ${r.reason_text}`;
    }

    return {
      ...defaults(),
      source: 'app',
      text,
      layer: CATEGORY_LAYER[r.category], // app 由来は層が確定（要件3.3）
      register: 'private', // 本人の私的回答
      created_at: r.submitted_at,
      origin: `app:${formatAnswerId(r.seq)}`, // app:ans_0123
    };
  });
}

/** Supabase から submitted かつ非スキップの回答を取得し、join を正規化する。 */
export async function fetchAppRows(client: SupabaseClient): Promise<AppRow[]> {
  const { data, error } = await client
    .from('answers')
    .select(APP_SELECT)
    .eq('status', 'submitted')
    .eq('skipped', false)
    .order('seq', { ascending: true });

  if (error) throw new Error(`Supabase 取得エラー: ${error.message}`);
  const list = (data ?? []) as unknown[];

  const rows: AppRow[] = [];
  for (const raw of list) {
    const a = raw as Record<string, unknown>;
    // join 結果 questions はドライバによって配列/オブジェクトのどちらもあり得る
    const qRaw = a.questions;
    const q = (Array.isArray(qRaw) ? qRaw[0] : qRaw) as Record<string, unknown> | undefined;
    if (!q || typeof q.category !== 'string' || typeof q.body !== 'string') continue; // 壊れた join はスキップ
    rows.push({
      seq: Number(a.seq),
      answer_text: (a.answer_text as string | null) ?? null,
      reason_text: (a.reason_text as string | null) ?? null,
      choice: (a.choice as 'A' | 'B' | null) ?? null,
      submitted_at: (a.submitted_at as string | null) ?? null,
      category: q.category as Category,
      body: q.body,
      body_options: (q.body_options as { A: string; B: string } | null) ?? null,
    });
  }
  return rows;
}

/** app ソース抽出のエントリ（client を注入可能にしてテスト容易に）。 */
export async function extractApp(client: SupabaseClient): Promise<ExtractResult> {
  const rows = await fetchAppRows(client);
  return { fragments: buildAppFragments(rows), skipped: 0 };
}

// -----------------------------------------------------------------------------
// 2) --source chatgpt : conversations.json（mapping 木）
// -----------------------------------------------------------------------------

interface ChatGptNode {
  message?: {
    author?: { role?: string };
    content?: { parts?: unknown[] };
    create_time?: number | null;
  } | null;
  parent?: string | null;
  children?: string[];
}

/** parts（文字列 or オブジェクト混在）から文字列部分のみを連結。 */
function joinParts(parts: unknown[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts.filter((p): p is string => typeof p === 'string').join('\n').trim();
}

/** mapping 木を root から children 順に辿り、会話順の node 列を返す（防御的に fallback）。 */
function orderChatGptNodes(mapping: Record<string, ChatGptNode>): ChatGptNode[] {
  const ids = Object.keys(mapping);
  const rootId = ids.find((id) => {
    const p = mapping[id]?.parent;
    return p == null || !(p in mapping);
  });
  const ordered: ChatGptNode[] = [];
  if (rootId) {
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return; // 循環参照ガード
      seen.add(id);
      const node = mapping[id];
      if (!node) return;
      ordered.push(node);
      for (const child of node.children ?? []) visit(child);
    };
    visit(rootId);
  } else {
    // root 不明: create_time でソート
    for (const id of ids) ordered.push(mapping[id]);
    ordered.sort(
      (a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0),
    );
  }
  return ordered;
}

export function parseChatGpt(json: unknown): ExtractResult {
  const conversations = Array.isArray(json) ? json : [];
  const fragments: PartialFragment[] = [];
  let skipped = 0;

  for (const convRaw of conversations) {
    const conv = convRaw as Record<string, unknown>;
    const mapping = conv.mapping as Record<string, ChatGptNode> | undefined;
    if (!mapping || typeof mapping !== 'object') {
      skipped++; // 壊れた会話
      continue;
    }
    const convId =
      (conv.id as string) ?? (conv.conversation_id as string) ?? 'unknown';

    const ordered = orderChatGptNodes(mapping);
    let prevAssistant: string | null = null;

    ordered.forEach((node, idx) => {
      const msg = node.message;
      const role = msg?.author?.role;
      const text = joinParts(msg?.content?.parts);

      if (role === 'assistant') {
        if (text.length > 0) prevAssistant = text;
        return;
      }
      if (role !== 'user') return; // system / tool 等は無視
      if (shouldSkipUtterance(text)) {
        if (text.trim().length > 0) skipped++; // 空以外の相槌のみ計上
        return;
      }

      const createdAt =
        typeof msg?.create_time === 'number'
          ? new Date(msg.create_time * 1000).toISOString()
          : null;

      fragments.push({
        ...defaults(),
        source: 'chatgpt',
        text,
        context: contextFrom(prevAssistant),
        created_at: createdAt,
        origin: `chatgpt:${convId}#${idx}`,
      });
    });
  }
  return { fragments, skipped };
}

// -----------------------------------------------------------------------------
// 3) --source claude : conversations.json（chat_messages 配列）
// -----------------------------------------------------------------------------

interface ClaudeMessage {
  sender?: string;
  text?: string;
  content?: unknown;
  created_at?: string;
}

/** Claude メッセージのテキスト抽出（text 優先、無ければ content 配列から）。 */
function claudeText(m: ClaudeMessage): string {
  if (typeof m.text === 'string' && m.text.trim().length > 0) return m.text.trim();
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => {
        const cc = c as Record<string, unknown>;
        return typeof cc.text === 'string' ? cc.text : '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

export function parseClaude(json: unknown): ExtractResult {
  const conversations = Array.isArray(json) ? json : [];
  const fragments: PartialFragment[] = [];
  let skipped = 0;

  for (const convRaw of conversations) {
    const conv = convRaw as Record<string, unknown>;
    const messages = conv.chat_messages;
    if (!Array.isArray(messages)) {
      skipped++;
      continue;
    }
    const uuid = (conv.uuid as string) ?? (conv.id as string) ?? 'unknown';
    let prevAssistant: string | null = null;

    messages.forEach((mRaw, idx) => {
      const m = mRaw as ClaudeMessage;
      const text = claudeText(m);
      if (m.sender === 'assistant') {
        if (text.length > 0) prevAssistant = text;
        return;
      }
      if (m.sender !== 'human') return;
      if (shouldSkipUtterance(text)) {
        if (text.trim().length > 0) skipped++;
        return;
      }
      fragments.push({
        ...defaults(),
        source: 'claude',
        text,
        context: contextFrom(prevAssistant),
        created_at: typeof m.created_at === 'string' ? m.created_at : null,
        origin: `claude:${uuid}#${idx}`,
      });
    });
  }
  return { fragments, skipped };
}

// -----------------------------------------------------------------------------
// 4) --source gemini : Google Takeout MyActivity.json
// -----------------------------------------------------------------------------

export function parseGemini(json: unknown): ExtractResult {
  const activities = Array.isArray(json) ? json : [];
  const fragments: PartialFragment[] = [];
  let skipped = 0;

  activities.forEach((actRaw, idx) => {
    const act = actRaw as Record<string, unknown>;
    const rawTitle = typeof act.title === 'string' ? act.title : '';
    // "Prompted <本文>" プレフィクスを防御的に除去（英/日いずれの表記も想定）
    const text = rawTitle
      .replace(/^Prompted\s+/i, '')
      .replace(/^プロンプト[:：]\s*/, '')
      .trim();

    if (shouldSkipUtterance(text)) {
      if (rawTitle.trim().length > 0) skipped++;
      return;
    }
    fragments.push({
      ...defaults(),
      source: 'gemini',
      text,
      created_at: typeof act.time === 'string' ? act.time : null,
      origin: `gemini:activity#${idx}`,
    });
  });
  return { fragments, skipped };
}

// -----------------------------------------------------------------------------
// 5) --source texts : md/txt（front-matter 必須）
// -----------------------------------------------------------------------------

export interface FrontMatter {
  meta: Record<string, string>;
  body: string;
}

/** --- で囲む front-matter を簡易パース。無ければ null。 */
export function parseFrontMatter(content: string): FrontMatter | null {
  const norm = content.replace(/^﻿/, '');
  const m = norm.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(':');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    meta[k] = v;
  }
  return { meta, body: m[2].trim() };
}

const TEXT_SOURCE_MAP: Record<string, { source: FragmentSource; register: FragmentRegister }> = {
  note: { source: 'note', register: 'public' },
  x: { source: 'x', register: 'public' },
  work: { source: 'work', register: 'formal' },
};

/** 1ファイル分の変換（純粋関数）。front-matter 不正なら null（呼び出し側で警告）。 */
export function parseTextFile(content: string, relPath: string): PartialFragment | null {
  const fm = parseFrontMatter(content);
  if (!fm) return null;
  const srcKey = (fm.meta.source ?? '').toLowerCase();
  const mapped = TEXT_SOURCE_MAP[srcKey];
  if (!mapped) return null; // source: note|x|work 以外
  if (fm.body.trim().length === 0) return null;

  return {
    ...defaults(),
    source: mapped.source,
    register: mapped.register,
    text: fm.body,
    context: fm.meta.title ? fm.meta.title : null,
    created_at: fm.meta.date ? fm.meta.date : null,
    origin: `texts:${relPath}`,
  };
}

export function parseTextsDir(dir: string): ExtractResult {
  const files = walkFiles(dir, ['.md', '.txt']);
  const fragments: PartialFragment[] = [];
  let skipped = 0;
  for (const file of files) {
    const rel = relative(dir, file);
    const frag = parseTextFile(readFileSync(file, 'utf8'), rel);
    if (frag) fragments.push(frag);
    else {
      skipped++;
      console.error(`  [texts] front-matter 不正/未対応のためスキップ: ${rel}`);
    }
  }
  return { fragments, skipped };
}

// -----------------------------------------------------------------------------
// 6) --source tensaku : 添削差分テンプレ準拠 md
// -----------------------------------------------------------------------------

/** "## 見出し" ブロックを { 見出し: 本文 } に分解（先頭のコードフェンスは除去）。 */
function splitTensakuSections(content: string): Record<string, string> {
  const cleaned = content.replace(/```[a-zA-Z]*\r?\n?/g, '').replace(/```/g, '');
  const parts = cleaned.split(/^##\s+/m);
  const sections: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const nl = block.indexOf('\n');
    const title = (nl === -1 ? block : block.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : block.slice(nl + 1)).trim();
    sections[title] = body;
  }
  return sections;
}

function findSection(sections: Record<string, string>, keyword: string): string {
  const key = Object.keys(sections).find((k) => k.includes(keyword));
  return key ? sections[key] : '';
}

/** media 欄 → register 推定（note/x→public、公文書→formal、他→private）。 */
export function registerFromMedia(media: string): FragmentRegister {
  const m = media.trim().toLowerCase();
  if (m === 'note' || m === 'x') return 'public';
  if (media.includes('公文書')) return 'formal';
  return 'private';
}

/** 1ファイル分の添削差分を構造抽出（純粋関数）。抽出不能なら null。 */
export function parseTensakuFile(content: string, fileName: string): PartialFragment | null {
  const sections = splitTensakuSections(content);
  const aiOut = findSection(sections, 'AI出力');
  const honnin = findSection(sections, '本人修正');
  const riyu = findSection(sections, '修正理由');

  // AI出力・本人修正の双方が空なら添削差分として成立しない
  if (aiOut.trim().length === 0 && honnin.trim().length === 0) return null;

  const mediaMatch = content.match(/^media:\s*(.+)$/m);
  const dateMatch = content.match(/^date:\s*(.+)$/m);
  const media = mediaMatch ? mediaMatch[1].trim() : '';

  const text =
    `【AI出力】\n${aiOut}\n\n【本人修正】\n${honnin}\n\n【修正理由】\n${riyu}`.trim();

  return {
    ...defaults(),
    source: 'tensaku',
    layer: null, // 03_tag で判定
    register: registerFromMedia(media),
    text,
    created_at: dateMatch ? dateMatch[1].trim() : null,
    origin: `tensaku:${fileName}`,
  };
}

export function parseTensakuDir(dir: string): ExtractResult {
  const files = walkFiles(dir, ['.md']);
  const fragments: PartialFragment[] = [];
  let skipped = 0;
  for (const file of files) {
    const frag = parseTensakuFile(readFileSync(file, 'utf8'), basename(file));
    if (frag) fragments.push(frag);
    else {
      skipped++;
      console.error(`  [tensaku] AI出力/本人修正が空のためスキップ: ${basename(file)}`);
    }
  }
  return { fragments, skipped };
}

// -----------------------------------------------------------------------------
// .env.local パーサ（seed.ts と同じ方式）
// -----------------------------------------------------------------------------
function loadEnvLocal(): Record<string, string> {
  const path = resolve(ROOT, '.env.local');
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

function requireEnv(local: Record<string, string>, key: string): string {
  const value = process.env[key] ?? local[key];
  if (!value) {
    console.error(
      `\n✖ 環境変数 ${key} が見つかりません。.env.local に設定してください（.env.example 参照）。`,
    );
    process.exit(1);
  }
  return value;
}

function makeSupabaseClient(): SupabaseClient {
  const local = loadEnvLocal();
  const url = requireEnv(local, 'NEXT_PUBLIC_SUPABASE_URL');
  const key = requireEnv(local, 'SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
const VALID_SOURCES = ['app', 'chatgpt', 'claude', 'gemini', 'texts', 'tensaku'] as const;
type CliSource = (typeof VALID_SOURCES)[number];

function parseArgs(argv: string[]): { source: CliSource; path: string | null } {
  const si = argv.indexOf('--source');
  if (si === -1 || !argv[si + 1]) {
    throw new Error('使い方: --source <app|chatgpt|claude|gemini|texts|tensaku> [path]');
  }
  const source = argv[si + 1] as CliSource;
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`未知のソース: ${source}（有効: ${VALID_SOURCES.join(', ')}）`);
  }
  // path = --source/値 以外の最初の位置引数
  const rest = argv.filter((a, i) => i !== si && i !== si + 1 && !a.startsWith('--'));
  return { source, path: rest[0] ?? null };
}

async function runSource(source: CliSource, path: string | null): Promise<ExtractResult> {
  if (source === 'app') {
    return extractApp(makeSupabaseClient());
  }
  if (!path) throw new Error(`--source ${source} にはパス引数が必要です`);
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new Error(`パスが存在しません: ${abs}`);

  switch (source) {
    case 'chatgpt':
      return parseChatGpt(readJson(abs));
    case 'claude':
      return parseClaude(readJson(abs));
    case 'gemini':
      return parseGemini(readJson(abs));
    case 'texts':
      return parseTextsDir(abs);
    case 'tensaku':
      return parseTensakuDir(abs);
  }
}

async function main(): Promise<void> {
  const { source, path } = parseArgs(process.argv.slice(2));
  console.error(`01_extract: source=${source}${path ? ` path=${path}` : ''}`);

  const result = await runSource(source, path);
  const numbered = numberFragments(result.fragments);

  const rawPath = resolve(ROOT, PIPELINE_PATHS.raw);
  const existing = readFragmentsJsonl(rawPath);
  const merged = mergeFragments(existing, source, numbered);
  writeFragmentsJsonl(rawPath, merged);

  console.error('\n=== ソース別 取込/スキップ件数 ===');
  console.error(`  ${source}: 取込 ${numbered.length} 件 / スキップ ${result.skipped} 件`);
  console.error(
    `  → ${PIPELINE_PATHS.raw} 更新（全 ${merged.length} 件。他ソース ${
      merged.length - numbered.length
    } 件は保持）`,
  );
}

// tsx で直接実行された時のみ main を走らせる（テストからの import では実行しない）。
if ((process.argv[1] ?? '').includes('01_extract')) {
  main().catch((err) => {
    console.error('\n✖ 予期しないエラー:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
