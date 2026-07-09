// =============================================================================
// scripts/seed.ts  —  質問バンク投入スクリプト
//
//   `npm run seed` から実行。service role key で questions テーブルへ upsert する
//   （id キー / onConflict）。本番文言への差し替えも、seed/questions.json を更新して
//   同スクリプトを再実行するだけで完了する（再実行安全）。
//
//   環境変数は .env.local から読む（NEXT_PUBLIC_SUPABASE_URL /
//   SUPABASE_SERVICE_ROLE_KEY）。dotenv には依存せず、自前で .env.local をパースする。
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { SeedQuestion } from '../src/lib/types';

const ROOT = resolve(__dirname, '..');
const BATCH_SIZE = 100;

// -----------------------------------------------------------------------------
// .env.local の最小パーサ（KEY=VALUE、# コメント、前後空白、両端クオートを処理）
// -----------------------------------------------------------------------------
function loadEnvLocal(): Record<string, string> {
  const path = resolve(ROOT, '.env.local');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // .env.local が無くても、既にプロセス環境に値があれば続行できるようにする
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
      `\n✖ 環境変数 ${key} が見つかりません。\n` +
        `  プロジェクト直下の .env.local に以下を設定してください（.env.example 参照）:\n` +
        `    NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co\n` +
        `    SUPABASE_SERVICE_ROLE_KEY=<service_role key>\n`,
    );
    process.exit(1);
  }
  return value;
}

async function main() {
  const local = loadEnvLocal();
  const supabaseUrl = requireEnv(local, 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv(local, 'SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // seed/questions.json 読み込み
  const seedPath = resolve(ROOT, 'seed', 'questions.json');
  const questions = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedQuestion[];
  console.log(`seed/questions.json を読み込みました: ${questions.length} 問`);

  // DBカラムに整形（source='seed' はDBデフォルトに任せ、明示しない）
  const rows = questions.map((q) => ({
    id: q.id,
    category: q.category,
    body: q.body,
    body_options: q.body_options ?? null,
  }));

  // バッチ分割して upsert（id で onConflict）
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('questions')
      .upsert(batch, { onConflict: 'id' });
    if (error) {
      console.error(
        `\n✖ upsert に失敗しました（バッチ ${i}–${i + batch.length - 1}）: ${error.message}`,
      );
      process.exit(1);
    }
    upserted += batch.length;
    console.log(`  upsert: ${upserted}/${rows.length}`);
  }

  // カテゴリ別件数を表示
  const byCategory = new Map<string, number>();
  for (const q of questions) {
    byCategory.set(q.category, (byCategory.get(q.category) ?? 0) + 1);
  }
  console.log('\n✔ 投入完了。カテゴリ別件数:');
  for (const cat of [...byCategory.keys()].sort()) {
    console.log(`    ${cat}: ${byCategory.get(cat)}`);
  }
  console.log(`    合計: ${questions.length}`);
}

main().catch((err) => {
  console.error('\n✖ 予期しないエラー:', err);
  process.exit(1);
});
