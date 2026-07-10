# 青松AI コーパスパイプライン

「青松のように考え、書き、判断するAI」を構築するための、生データ→コーパス4ファイルの変換パイプライン。
判断基準・全体構想は [`docs/requirements_aomatsu_ai.md`](../docs/requirements_aomatsu_ai.md)（特に 3.3 データパイプライン）、
運用の使い方は [`docs/phase1-runbook.md`](../docs/phase1-runbook.md) を参照。

## 5工程の全体像

```
[01_extract]        各社エクスポート/文章/添削差分 → Fragment（本人の声のみ）に正規化
       │             pipeline/sources/ → pipeline/work/fragments_raw.jsonl
       ▼
[02_anonymize]       NG辞書 + 汎用パターンで機微情報を検出 → 目視レビュー → 確定削除
       │             pipeline/work/fragments_raw.jsonl → fragments_clean.jsonl
       ▼
[03_tag]             Claude APIで {layer, topics, register, confidence} を付与
       │             fragments_clean.jsonl → fragments_tagged.jsonl
       ▼
[04_integrate]       コーパス素材へ振り分け + 3モデル交差検証レポート
       │             fragments_tagged.jsonl → corpus/materials/
       ▼
[05_kernel_draft]    現行カーネル/スタイルガイドへの更新差分案をLLMが生成（月次）
                     corpus/materials/ → pipeline/work/kernel_draft.md（本人レビュー用。corpusは自動更新しない）
```

全工程は `pipeline/lib/fragment.ts` の `Fragment` 型と `pipeline/lib/fragment.ts` の `PIPELINE_PATHS` を共有する。
各断片は `origin`（出典ID。例: `app:ans_0123` / `chatgpt:<conv-id>#3` / `texts:note.md`）を必ず保持し、
コーパスに反映された後も原典まで遡れる。

## 各コマンドの使い方

### 01_extract — ソース正規化

```bash
# アプリ回答（Supabaseから直接取得。NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要）
npm run pipeline:extract -- --source app

# ChatGPT（conversations.jsonのパス）
npm run pipeline:extract -- --source chatgpt pipeline/sources/chatgpt/conversations.json

# Claude（conversations.jsonのパス）
npm run pipeline:extract -- --source claude pipeline/sources/claude/conversations.json

# Gemini（Google TakeoutのMyActivity.jsonのパス）
npm run pipeline:extract -- --source gemini pipeline/sources/gemini/MyActivity.json

# 公開文章・業務文書（ディレクトリを指定。front-matterで note/x/work を判定）
npm run pipeline:extract -- --source texts pipeline/sources/texts

# 添削差分（テンプレ準拠mdのディレクトリを指定）
npm run pipeline:extract -- --source tensaku pipeline/sources/tensaku
```

- 出力は `pipeline/work/fragments_raw.jsonl`。**同一ソースの断片だけを置き換えるマージ書き込み**なので、
  複数ソースを順番に実行すれば全ソース分が蓄積される（実行順は問わない）。
- 各社エクスポート形式は変わり得るため、パーサは防御的に実装されている。壊れた会話・空の発話・
  「ありがとう」等の相槌のみの発話は自動スキップされ、件数がターミナルに表示される。

### 02_anonymize — 匿名化（最重要の安全工程）

```bash
# 検出のみ（レポート生成）
npm run pipeline:anonymize

# レポートを目視確認した後、確定（検出断片を削除）
npm run pipeline:anonymize -- --apply

# 目視の結果「誤検出だったので残す」と判断した断片がある場合
npm run pipeline:anonymize -- --apply --allow frg_claude_000012,frg_chatgpt_000034
```

- 検出結果は `pipeline/work/anonymize_report.md` に出力される。**必ず本人が目視でレビュー**すること。
- `--apply` はレポートが「未生成」または「`raw`/NG辞書の更新より古い」場合は拒否される
  （＝目視レビューを必ず一度挟ませる仕組み）。レポートを確認し直したら再度 `npm run pipeline:anonymize`
  （引数なし）でレポートを再生成してから `--apply` する。
- ヒットした断片は**仮名化ではなく削除**が原則（生徒情報は特に）。出力は `pipeline/work/fragments_clean.jsonl`。

### 03_tag — LLMタグ付け

```bash
# 既定（claude-sonnet-5、バッチ20件）
npm run pipeline:tag

# モデル・バッチサイズを指定
npm run pipeline:tag -- --model claude-sonnet-5 --batch-size 30
```

- 入力は `fragments_clean.jsonl`（02未実施なら明確なエラーで停止）。
- 出力 `pipeline/work/fragments_tagged.jsonl` は**追記式**。既に処理済みの断片idはスキップされるため、
  APIエラー等で中断しても同じコマンドを再実行するだけで再開できる（やり直しではなく続きから）。
- `app` 由来の断片は `layer` が既に確定しているため上書きしない（topicsのみ付与）。
- 実行終了時にターミナルへ「リクエスト件数 / 消費トークン / 概算コスト」のサマリが出る。

### 04_integrate — コーパス統合 + 3モデル交差検証

```bash
npm run pipeline:integrate
```

- 入力は `fragments_tagged.jsonl`。`anonymized: true` の断片のみを対象とする
  （`false` が混在していれば警告して除外する＝02未通過分の混入防止）。
- 出力は `corpus/materials/`（**既存ファイルは全再生成**）。
  - `thinking/<トピック>.md` — 思考層をトピック別に集約（出典ID付き引用）
  - `style_samples.md` — 文体層をレジスタ別（公開/私的/フォーマル）に整理
  - `facts_candidates.md` — 知識層の `corpus/facts/facts.md` 転記候補
  - `cross-model-report.md` — 3モデル交差検証（2モデル以上共通＝カーネル昇格候補、単一モデルのみ＝適応疑い）
  - `INDEX.md` — 生成ファイル一覧と断片数サマリ

### 05_kernel_draft — カーネル/スタイルガイド更新草案（月次）

```bash
# ペルソナカーネルの更新差分案（既定）
npm run pipeline:draft -- --target kernel

# スタイルガイドの更新差分案
npm run pipeline:draft -- --target style

# モデル指定（既定 claude-fable-5）
npm run pipeline:draft -- --target kernel --model claude-fable-5
```

- 入力は `corpus/materials/` 一式 + `cross-model-report.md` + 現行の `corpus/kernel/persona-kernel.md`
  （または `corpus/style-guide.md`）。materials 合計が10万字を超える場合は先頭から打ち切り、草案冒頭に注記される。
- 出力は `pipeline/work/kernel_draft.md`（または `style_draft.md`）。**corpus/ を自動で書き換えることはしない**。
  各提案には根拠となる断片の出典IDが付く。本人がレビューして手動で `corpus/kernel/persona-kernel.md` 等に
  反映し、`corpus/CHANGELOG.md` にバージョンを記録する（採否決定は常に人間。要件4.4）。

## データの置き方（pipeline/sources/）

`pipeline/sources/` は `.gitignore` 対象（生データはコミットしない）。以下のディレクトリ構成で配置する。

```
pipeline/sources/
├── chatgpt/conversations.json     # ChatGPTエクスポートをそのまま置く
├── claude/conversations.json      # Claudeエクスポートをそのまま置く
├── gemini/MyActivity.json         # Google Takeoutの中の MyActivity.json
├── texts/                         # 公開文章・業務文書（md/txt、front-matter必須）
│   ├── note/2026-01-15-title.md
│   ├── x/2026-02-20-post.txt
│   └── work/proposal.md
└── tensaku/                       # 添削差分（テンプレ準拠md）
    └── 20260410_uc1-note.md
```

### 各社エクスポートの取得方法

- **Claude**: claude.ai → 右上のアカウントメニュー → 設定 → 「データエクスポート」からリクエスト。
  メールでダウンロードリンクが届く。展開して `conversations.json` を `pipeline/sources/claude/` に置く。
- **ChatGPT**: chatgpt.com → 設定 → Data controls → Export data。メールでダウンロードリンクが届く。
  展開して `conversations.json` を `pipeline/sources/chatgpt/` に置く。
- **Gemini**: [Google Takeout](https://takeout.google.com/) で「Gemini Apps」（または「My Activity」）を選択して
  エクスポート。展開後、`Takeout/My Activity/Gemini Apps/MyActivity.json` を `pipeline/sources/gemini/` に置く。

### texts/ の front-matter 書式

md/txt先頭に `---` で囲んだ front-matter を必須で付ける。`source` が `note|x|work` 以外、または本文が空のファイルはスキップされる。

```
---
source: note
date: 2026-01-15
title: 教えないという教え方
---

（本文をここに）
```

- `source: note` / `x` → register: public（公開文章）
- `source: work` → register: formal（業務文書。提案書・稟議・教材等）

### tensaku/ の書式

[`docs/templates/tensaku-diff-template.md`](../docs/templates/tensaku-diff-template.md) を参照。
テンプレを1ファイルにコピーして `pipeline/sources/tensaku/YYYYMMDD_<短い題名>.md` として保存する。

## NG辞書の整備（pipeline/private/ng-words.txt）

`pipeline/private/ng-words.txt` は `.gitignore` 対象。**匿名化の精度はこの辞書の質に依存する**ため、
運用開始前に必ず整備すること。

- 1行1語。`#` で始まる行と空行は無視される。
- 生徒氏名（フルネーム・下の名前のみ・あだ名）、同僚の実名、学校固有名（校名・略称）などを列挙する。
- 汎用パターン（敬称+成績/進路等の文脈語の共起、`N年M組`、出席番号、メール/電話）は辞書が無くても検出されるが、
  **人名そのものの判定は辞書無しでは原理的に不可能**（一般語との区別がつかないため）。辞書が未整備または
  空のときは `02_anonymize` がターミナルとレポートに警告を出す。

```
# pipeline/private/ng-words.txt の例
山田太郎
やまちゃん
青松高校
```

辞書を編集したら、既存レポートは無効になる（`02_anonymize` を引数なしで再実行してレポートを作り直す）。

## LLM APIキーの設定と概算コスト

`03_tag` と `05_kernel_draft` のみLLM APIを使用する。**既定プロバイダは Gemini**（無料枠で運用できる）。
`.env.local` に以下を追記する。

```
GEMINI_API_KEY=...
```

キーは [aistudio.google.com](https://aistudio.google.com/) → Get API key から**クレジットカード不要**で発行できる。
未設定のまま実行すると `03_tag` / `05_kernel_draft` は起動時に明確なエラーメッセージで停止する（他の工程はキー不要）。

### プロバイダとモデル

| 工程 | 既定（Gemini） | 切替（Claude） |
|---|---|---|
| 03_tag | `gemini-3.5-flash`（無料枠対象） | `--provider claude` → `claude-sonnet-5` |
| 05_kernel_draft | `gemini-3.5-flash`（無料枠対象） | `--provider claude` → `claude-fable-5` |

- Geminiの無料枠は **Flash / Flash-Lite 系のみ**（Pro系は有料のみ、2026-07時点）。無料キーはレート制限があるため、
  `03_tag` で429が続く場合はバッチ間隔が自動リトライで吸収される（それでも止まったら再実行で再開できる）
- 草案の質を上げたい月は `npm run pipeline:draft -- --target kernel --model gemini-3.1-pro`（有料）や
  `--provider claude`（`ANTHROPIC_API_KEY` が必要、claude-fable-5）を使う

### 概算コスト目安

正確な単価は `pipeline/lib/claude-api.ts` / `pipeline/lib/gemini-api.ts` の `MODEL_PRICING`（USD / 100万トークン）を参照。
実行終了時には毎回「消費トークン・概算コスト」がターミナルに表示される（**無料枠内で収まっていれば実際の請求は$0**。
表示は有料単価での保守的な概算）。

- **03_tag**（gemini-3.5-flash）: AIログ1万断片程度で有料換算$2〜4のオーダー。無料枠のレート制限内なら$0
- **05_kernel_draft**（gemini-3.5-flash）: 1回$0.5〜2のオーダー（同上）。claude-fable-5利用時は$1〜3程度

## トラブルシュート

| 症状 | 原因・対処 |
|---|---|
| `02_anonymize --apply` が「レポートが未生成です」等で拒否される | 先に引数なしで `npm run pipeline:anonymize` を実行してレポートを生成・目視レビューする。NG辞書を編集した後も同様に再生成が必要（レポートより辞書が新しいと拒否される仕組み） |
| `03_tag` を実行したらAPIエラーで途中で止まった | 何もせず同じコマンド（`npm run pipeline:tag`）を再実行すればよい。`fragments_tagged.jsonl` に既に書き出し済みのidは自動でスキップされ、続きから処理される |
| `03_tag` 実行後、一部のidが「未タグのまま残った」と警告される | バッチ応答のJSONパースに失敗した断片。stderrに出たidを確認のうえ、そのまま `npm run pipeline:tag` を再実行すれば次回また対象になる |
| `topics` に「要匿名化再確認」が付いた | タグ付けLLMが機微情報の可能性に気づいたケース。該当断片idがstderrに一覧表示されるので、`02_anonymize` の辞書に追記して02からやり直すことを検討する |
| `04_integrate` が「タグ付け済み断片が見つかりません」で止まる | 先に `npm run pipeline:tag` を実行して `pipeline/work/fragments_tagged.jsonl` を生成する |
| `04_integrate` が「anonymized=false の断片を除外しました」と警告する | `03_tag` の入力に02未通過の断片が混入している。通常は起きないはずなので `fragments_clean.jsonl` の生成経路を確認する |
| `05_kernel_draft` が「素材(md)が見つかりません」で止まる | 先に `npm run pipeline:integrate` を実行して `corpus/materials/` を生成する |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` が見つからないエラー | `.env.local` に追記されているか確認（`.env.example` 参照）。`03_tag` / `05_kernel_draft` のみ必要。既定はGemini、`--provider claude` 指定時のみAnthropicキーが要る |
| `01_extract --source app` が環境変数エラーで止まる | `.env.local` に `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` が設定されているか確認 |

## テスト

```bash
npm test
```

`pipeline/__tests__/` 配下に5工程それぞれのユニットテスト（fixtures使用、外部API・Supabase不要）がある。
