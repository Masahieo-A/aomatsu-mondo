# 青松問答 v1.0

青松AI構築プロジェクトのデータ収集フェーズを担う、日次質問回答アプリ「青松問答」。
Google OAuthでログインした本人（シングルユーザー）が約350問の質問に回答し、回答データを青松AIの思考層コーパスとしてJSONL形式でエクスポートするための私的ツール。

- 実装正典（アプリ仕様）: [`docs/requirements_collection_app.md`](./docs/requirements_collection_app.md)
- 判断基準（全体構想）: [`docs/requirements_aomatsu_ai.md`](./docs/requirements_aomatsu_ai.md)

エクスポート形式は `requirements_collection_app.md` の「4.6 エクスポート仕様」に厳密準拠する（詳細は本README下部の「エクスポート」参照）。

## セットアップ手順

### 1. Supabaseプロジェクト作成

[supabase.com](https://supabase.com) で新規プロジェクトを作成する（Region は任意、東京近辺推奨）。プロジェクト作成後、`Project Settings > API` に表示される以下を控えておく（後述の `.env.local` で使う）。

- Project URL
- anon / public key
- service_role key（`npm run seed` 専用。クライアントには絶対公開しない）

### 2. Google OAuth設定

1. [Google Cloud Console](https://console.cloud.google.com/) で新規（または既存）プロジェクトを開き、「APIとサービス > 認証情報」から **OAuthクライアントID**（アプリケーションの種類: ウェブアプリケーション）を作成する。
2. 「承認済みのリダイレクトURI」に、Supabase側のコールバックURLを追加する。
   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```
   （`<project-ref>` はSupabaseプロジェクトのURLに含まれる文字列。Supabaseの `Authentication > Providers > Google` 画面にもこのURLが表示される）
3. 作成した **クライアントID** と **クライアントシークレット** を、Supabaseダッシュボードの `Authentication > Providers > Google` に設定し、プロバイダを有効化する。
4. Supabaseの `Authentication > URL Configuration` で、以下を設定する。
   - **Site URL**: `NEXT_PUBLIC_SITE_URL`（本番URL。ローカル開発中は `http://localhost:3000` でよい）
   - **Redirect URLs**: `http://localhost:3000/auth/callback` と本番の `https://<本番ドメイン>/auth/callback` の両方を追加（アプリ側のOAuthコールバックルートは `src/app/auth/callback/route.ts`）

### 3. マイグレーション適用

Supabaseダッシュボードの `SQL Editor` を開き、`supabase/migrations/00001_init.sql` の内容を貼り付けて実行する。

（Supabase CLIを使う場合は `supabase db push` でも同等）

このマイグレーションで `allowed_emails` / `questions` / `answers` / `coverage` view / RLSポリシーが一括作成される。

### 4. ホワイトリスト登録

マイグレーション適用後、同じくSQL Editorで、ログインを許可する自分のGoogleアカウントのメールアドレスを1件insertする（本アプリはシングルユーザー専用）。

```sql
insert into allowed_emails (email) values ('あなたのGoogleアカウントのメール');
```

ここに登録されていないメールでログインすると、OAuth自体は成功してもアプリ側で強制サインアウトされ `/login?error=not_allowed` に戻される（`getAllowedUser()` によるRLS越しの照合、`src/lib/auth.ts`）。

### 5. .env.local 設定

`.env.example` を `.env.local` にコピーし、各キーを設定する。

```bash
cp .env.example .env.local
```

| 変数名 | 用途 | 取得場所 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabaseプロジェクトへの接続先URL | Supabase: Project Settings > API（Project URL） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | クライアント側からのSupabaseアクセス用キー | Supabase: Project Settings > API（anon / public key） |
| `SUPABASE_SERVICE_ROLE_KEY` | `npm run seed` によるデータ投入専用の管理者キー（クライアントには公開しない） | Supabase: Project Settings > API（service_role key） |
| `NEXT_PUBLIC_SITE_URL` | アプリの公開URL（OAuthリダイレクト先の組み立てに使用） | ローカル: `http://localhost:3000` / 本番: デプロイ先のURL |

### 6. インストール・seed投入・起動

```bash
npm install
npm run seed   # seed/questions.json（350問）を questions テーブルへ投入
npm run dev
```

`npm run seed` は `id` をキーにした upsert のため、何度実行しても安全（差し替え手順は後述）。

## 動作確認手順（完了条件）

1. `http://localhost:3000` にアクセス → 未認証なら `/login` へリダイレクトされる
2. Googleでログイン → ホワイトリストに登録したアカウントなら質問一覧（`/`）が表示される
3. 一覧から任意の質問を開く（`/q/[id]`）
4. 回答を途中まで入力する（2秒入力停止 or フォーカス外し・画面遷移で自動保存される）
5. ブラウザタブを閉じる（または一覧へ戻る）
6. 再度同じ質問を開く → **入力内容が復元されること**を確認
7. 回答を確定送信する
8. 一覧に戻り、**該当質問のバッジが「回答済み」に即時更新されること**を確認

非ホワイトリストのGoogleアカウントでログインした場合は、拒否されて `/login?error=not_allowed` に戻ることも合わせて確認する。

## エクスポート

- 画面右上ヘッダーの「エクスポート」リンク、または `GET /api/export` に直接アクセスすることで、JSONLファイルがダウンロードされる（未認証・非ホワイトリストは401）。
- ファイル名: `aomatsu_mondo_answers_YYYYMMDD.jsonl`（`YYYYMMDD` はJST基準の日付）
- 対象: `status='submitted' かつ skipped=false` の回答のみ（下書き・スキップ済みは含まれない。要件定義書5.「エクスポート対象は `status = submitted` のみ」に加え、計画の判断でスキップ行も除外）
- 出力順: `seq`（回答の連番）昇順
- 1行1レコードのJSON（キー順は要件定義書4.6の例と同一固定）:

  ```jsonl
  {"id":"ans_0123","category":"Q2","question":"...","answer":"...","reason":"...","followup_q":null,"followup_a":null,"layer":"thinking","topics":[],"register":"private","input_mode":"text","answered_at":"2026-07-20T07:45:00+09:00","revision_of":null}
  ```

  - `id`: `ans_` + `seq` を最低4桁ゼロ埋め（5桁以上はそのまま桁が増える）
  - `layer`: カテゴリからの固定マッピング（`src/lib/types.ts` の `CATEGORY_LAYER`）
  - `topics` / `register` / `input_mode`: v1.0はそれぞれ常に `[]` / `"private"` / DB値そのまま（`text`固定）
  - `answered_at`: `submitted_at` をJST(+09:00)のISO8601に整形（ミリ秒なし）
  - `revision_of`: 再回答元がある場合のみ、参照先回答の同形式id。無ければ `null`
  - 0件の場合も200 + 空ボディで返る

  変換ロジックは `src/lib/export.ts`（純粋関数、ユニットテスト対象）、DB取得・レスポンス生成は `src/app/api/export/route.ts` が担当する。

## 質問文の差し替え方法

`seed/questions.json` を編集し、`npm run seed` を再実行する。`id` をキーにした upsert のため、既存の `id` の行は本文が上書きされ、新しい `id` の行は追加される（回答済みデータ `answers` は `question_id` で紐づいているため、`id` を変えない限り既存回答は失われない）。

## テスト

```bash
npm test
```

`src/lib/__tests__/` 配下にautosave / answers / export の各ユニットテストがある（Supabase不要、モック/純粋関数のみで検証）。

## 開発コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー起動 |
| `npm run build` | 本番ビルド |
| `npm run start` | 本番サーバー起動 |
| `npm run lint` | ESLint実行 |
| `npm test` | vitestによるユニットテスト実行 |
| `npm run seed` | 質問データのDB投入（`scripts/seed.ts`） |

## 技術スタック

- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase（`@supabase/supabase-js` / `@supabase/ssr`、Postgres + Auth + RLS）
- vitest（ユニットテスト）

## v1.0のスコープ外（未実装、v1.1予定）

要件定義書 8.「開発スコープ」のとおり、以下はv1.0では実装しない。

- **音声入力**（Web Speech API。話し言葉のまま保存するオプション含む）
- **フォローアップ生成**（回答確定後にClaude APIが「なぜ？」を1問生成する任意深掘り）
- **進捗ダッシュボード**（カテゴリ別カバレッジのヒートマップ・総回答文字数などの可視化。最小限のカバレッジ表示のみ一覧画面に実装済み）
- **管理画面**（質問バンクのCRUD・LLM一括生成→監修フロー・回答閲覧編集・Markdownエクスポート）
- **オフライン退避**（保存失敗時のlocalStorage退避・復帰時同期。現状は保存失敗をトースト通知し、入力内容はReact側stateに保持したまま次回発火点でリトライする）

なお、再回答（`revision_of`）のデータロジック自体（`src/lib/answers.ts` の `reviseAnswer` / `canReask`）はv1.0で実装・テスト済みだが、UI（再回答ボタンの表示）はv1.0のスコープ外。
