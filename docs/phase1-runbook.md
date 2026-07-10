# 青松AI Phase 1 運用手順書

Phase 1（要件4.3）は「コーパス4ファイルをClaude Projectのナレッジに載せ、即日運用開始する」段階。
目的は最速で添削差分の収集ループを回し始めることであり、ナレッジ容量・検索精度・差分記録の手間の
限界が見えたらPhase 2（専用アプリ）へ移行する。

判断基準・全体構想: [`docs/requirements_aomatsu_ai.md`](./requirements_aomatsu_ai.md)
パイプラインの操作方法: [`pipeline/README.md`](../pipeline/README.md)

---

## ① コーパス4ファイルをClaude Projectのナレッジに載せる手順

1. [claude.ai](https://claude.ai) にログイン → 左サイドバー「Projects」→「新規プロジェクトを作成」。
   プロジェクト名は「青松AI」など判別しやすい名前にする。
2. プロジェクト画面の「Knowledge」（ナレッジ）セクションを開き、以下の4ファイルをアップロードする。
   - `corpus/kernel/persona-kernel.md`
   - `corpus/style-guide.md`
   - `corpus/facts/facts.md`
   - `corpus/fewshot/uc1.jsonl` 〜 `uc5.jsonl`（5ファイルまとめてアップロード可）
3. プロジェクトの「カスタム指示（Custom instructions）」に、カーネルの位置づけを明示する例文を入れる。

   ```
   あなたは「青松AI」。ナレッジにアップロードされた persona-kernel.md は
   あなたの人格の最上位定義であり、他の全ての判断に優先する。
   style-guide.md は文体規則（良例・悪例ペア、媒体別レジスタ）。
   facts.md は経歴・プロジェクト・人間関係の事実DB（時点情報 as_of 付き。
   share: internal-only の項目は外部発信の文面に使わない）。
   uc1〜uc5.jsonl は過去に本人が採点した入出力例。同種の依頼が来たら
   参考にしつつ、機械的な模倣ではなく persona-kernel.md の判断原則から
   出力を組み立てること。
   出力は必ず「下書き」として扱い、本人の最終確認・修正を前提とする
   （青松の名義でそのまま外部発信しない）。
   生徒・保護者・同僚の個人が特定できる情報は絶対に出力しない。
   ```

4. 保存後、新規チャットを開いて簡単な依頼（UC1〜UC3のいずれか）を投げ、カーネルの内容を踏まえた
   応答になっているか確認する。

## ② UC1〜UC3の使い方プロンプト例

### UC1: 下書き生成

```
UC1（下書き生成）。媒体はNote。テーマは「定期考査を無くしたい理由」。
骨子: 評価のための評価になっている／観点別評価と相性が悪い／
代替として何を考えているかは触れなくてよい、問題提起だけで締める。
800字程度。
```

### UC2: 青松らしさ添削

```
UC2（青松らしさ添削）。以下は他AI（ChatGPT）が書いた草稿。
青松ならどう直すか、修正案と「なぜそう直すか」を分けて出して。

---
（草稿を貼る）
---
```

### UC3: 企画壁打ち

```
UC3（企画壁打ち）。以下の企画案について、青松視点で懸念点と発展案を挙げて。
遠慮せず、弱いところは弱いと言ってほしい。

企画案: 探究学習の発表会を校内だけでなく地域住民にも公開する。
狙いは生徒の当事者意識向上と、学校の情報発信。
```

## ③ 添削差分の記録手順

添削差分は全データソース中**最も信頼できる校正データ**（実際に直した跡＝行動データ）。UC1〜UC3で
Claude Projectの出力を直すたびに、以下のループを回す。

1. [`docs/templates/tensaku-diff-template.md`](./templates/tensaku-diff-template.md) をコピーし、
   「依頼」「AI出力（修正前）」「本人修正（修正後）」「修正理由」「採点」を埋める。
   **修正理由が最も価値のあるデータなので省略しない**（「説明的すぎる」「この場面で駄洒落は打たない」等、
   1行でよいので必ず書く）。
2. 生徒・保護者・同僚の実名や機微情報が混ざっていないか確認し、あれば保存前に除去する。
3. `pipeline/sources/tensaku/YYYYMMDD_<短い題名>.md` として保存する。
4. その場でコーパスに反映されるわけではない。**次回の月次パイプライン実行**（④参照）の
   `npm run pipeline:extract -- --source tensaku pipeline/sources/tensaku` で自動的に取り込まれ、
   `03_tag` でタグ付け、`04_integrate` で `corpus/materials/style_samples.md` 等に集約され、
   `05_kernel_draft` の草案生成時にスタイルガイド・カーネルの更新根拠として使われる。
   → **記録 → 蓄積 → 月次で草案に反映 → 採用したらスタイルガイド/カーネルが更新される**、というループ。

## ④ 月次更新フロー

添削差分・アプリ回答は月次でレビューし、採否を本人が決定してカーネル/スタイルガイドをバージョン更新する
（要件4.4）。手順は以下の順で実行する。

1. **エクスポート更新**: Claude/ChatGPT/Geminiの新規ログをエクスポートし直し `pipeline/sources/` 配下に
   上書き配置（前回分含む全量が入ったエクスポートで問題ない）。
2. **抽出**（全ソース）:
   ```bash
   npm run pipeline:extract -- --source app
   npm run pipeline:extract -- --source claude pipeline/sources/claude/conversations.json
   npm run pipeline:extract -- --source chatgpt pipeline/sources/chatgpt/conversations.json
   npm run pipeline:extract -- --source gemini pipeline/sources/gemini/MyActivity.json
   npm run pipeline:extract -- --source texts pipeline/sources/texts
   npm run pipeline:extract -- --source tensaku pipeline/sources/tensaku
   ```
3. **匿名化**: `npm run pipeline:anonymize` → `pipeline/work/anonymize_report.md` を目視レビュー
   → 問題なければ `npm run pipeline:anonymize -- --apply`（誤検出があれば `--allow` で除外）。
4. **タグ付け**: `npm run pipeline:tag`（中断したら同じコマンドで再開できる）。
5. **統合**: `npm run pipeline:integrate` → `corpus/materials/` と `cross-model-report.md` を生成。
6. **草案生成**: `npm run pipeline:draft -- --target kernel` と `npm run pipeline:draft -- --target style`
   → `pipeline/work/kernel_draft.md` / `pipeline/work/style_draft.md` を生成。
7. **草案レビュー**: 本人が草案を読み、出典IDを確認しながら採否を判断する。3モデル交差検証
   （`cross-model-report.md`）で2モデル以上に共通する項目を優先的に採用し、単一モデルのみの項目は
   「そのモデルへの適応」を疑って慎重に扱う。
8. **corpus反映**: 採用した内容を手作業で `corpus/kernel/persona-kernel.md` / `corpus/style-guide.md` /
   `corpus/facts/facts.md` に反映する（自動反映はしない。反映は常に人間の作業）。
9. **CHANGELOG更新**: `corpus/CHANGELOG.md` にバージョン（v0.2, v0.3...）と変更概要を追記する。
10. **git commit**: `corpus/` の変更をコミットする（`corpus/` はGit管理対象。GitHub Privateへのpush許容）。
11. **Claude Projectナレッジ差し替え**: claude.ai のProject Knowledgeで、更新した4ファイルを再アップロード
    （同名ファイルは上書きされる。または一度削除してから再アップロード）。

## ⑤ 評価計画の運用

要件5の評価計画（ブラインドテスト/タスク採点/思考再現テスト/欠落検出）を以下のように運用する。

### ブラインドテストの実施手順（月次）

1. 本人が最近書いた文章（Note/X等）と、青松AIに同テーマ・同媒体で書かせた文章を1〜2セット用意する
   （UC1で生成、本人の添削は入れない生の出力を使う）。
2. 配偶者・同僚などブラインドテスト協力者に、どちらが本人の文章か当ててもらう（本人か否かのみ伝え、
   どちらがAIかは伝えない）。
3. 判別結果（正答/誤答、判断理由のコメントがあれば）を記録する。合格基準: 判別率が70%→55%へ低下。
4. 記録は `docs/phase1-runbook.md` 本節の下、または別途 `docs/` 配下にログを追記していく運用でよい
   （Phase 2で管理画面ができるまでは手動メモで十分）。

### UC出力の採点記録（fewshot/*.jsonlへの蓄積）

UC1〜UC3の出力は使うたびに5段階で採点し、`corpus/fewshot/uc<N>.jsonl` に1行追加する。

```json
{"input": "依頼文", "output": "採用した出力（本人修正後でよい）", "score": 4, "note": "採点理由・使いどころ", "added_at": "2026-07-10"}
```

- score 4以上のものが実質的なfew-shot例として次回以降の参照価値を持つ（`corpus/fewshot/README.md` 参照）。
- 平均3.5以上・修正率50%以下が合格基準（要件5）。月次で `uc*.jsonl` の score 平均を簡単に集計して確認する
  （例: `jq -s 'map(.score) | add/length' corpus/fewshot/uc1.jsonl`）。

### 欠落検出ログ（青松問答の管理画面ができるまでは手動運用）

青松AIが「答えられなかった/明らかに外した」質問に気づいたら、その場で以下をメモしておく。

- 質問・依頼の内容
- 何が欠けていたか（知識層の欠落か、思考層の判断基準が無いのか）
- 気づいた日付

管理画面（収集アプリのgap_detection機能）が実装されるまでは、`pipeline/work/` ではなく
リポジトリ外のメモ（本人の日常メモツール等）か、`docs/` 配下に `gap-log.md` を作って手動追記する運用とする。
月次更新フロー実行時に、蓄積した欠落メモを見返し、**次月の収集アプリ（青松問答）の質問テーマ**に
反映する（新規質問の追加は `seed/questions.json` を編集して `npm run seed`）。

## ⑥「350問回答が揃った日にやること」チェックリスト

青松問答v1.0で350問の回答が出揃った日に、最初の一気通貫実行を行う手順。

1. `.env.local` に `GEMINI_API_KEY` が設定されていることを確認する（未設定なら
   [aistudio.google.com](https://aistudio.google.com/) → Get API key でクレジットカード不要で発行して追記。
   パイプラインの既定プロバイダはGeminiで、無料枠で運用できる。詳細: `pipeline/README.md`）。
2. AI対話ログをエクスポートする（Claude/ChatGPT/Geminiのうち手元にあるもの。②の月次更新フロー
   手順1と同じ）。公開文章・業務文書があれば `pipeline/sources/texts/` に front-matter 付きで配置する。
3. `pipeline/private/ng-words.txt` を整備する（生徒名・同僚名・学校固有名を1行1語で列挙）。
   **これが匿名化の精度を決めるので、この時点で最も時間をかけるべき作業**（`pipeline/README.md` の
   「NG辞書の整備」参照）。
4. `npm run pipeline:extract -- --source app` を実行し、350問の回答を取り込む。
5. 手元にある他ソース（claude/chatgpt/gemini/texts/tensaku）も同様に `npm run pipeline:extract` する。
6. `npm run pipeline:anonymize` → `pipeline/work/anonymize_report.md` を**必ず全件目視レビュー**する
   （初回は件数が多いので時間を確保する）。
7. レビュー後 `npm run pipeline:anonymize -- --apply` で確定する。
8. `npm run pipeline:tag` を実行する（AIログの件数によっては数分〜数十分かかる。中断しても再実行で
   再開できる）。実行後、「要匿名化再確認」の警告が出た断片があれば内容を確認し、必要なら3.に戻って
   辞書を追記し02からやり直す。
9. `npm run pipeline:integrate` を実行し、`corpus/materials/` と `cross-model-report.md` を生成する。
10. `npm run pipeline:draft -- --target kernel` を実行し、初回のペルソナカーネル草案
    （`pipeline/work/kernel_draft.md`）を生成する。続けて `npm run pipeline:draft -- --target style` で
    スタイルガイド草案も生成する。
11. 草案を読み、出典IDを確認しながら `corpus/kernel/persona-kernel.md` と `corpus/style-guide.md` に
    手作業で反映する（TODOになっている「FABLE_LEGACY.mdの所在確認」もこのタイミングで着手する）。
12. `corpus/facts/facts.md` に `corpus/materials/facts_candidates.md` の内容を確認しながら転記する
    （`as_of` と `share: ok|internal-only` を必ず付ける）。
13. `corpus/CHANGELOG.md` に v0.2 として記録し、git commit する。
14. 本書の①の手順でClaude Projectを作成し、4ファイルをナレッジにアップロードする。
15. ②のUC1〜UC3のプロンプト例で試し、Phase 1運用（③の添削差分収集ループ）を開始する。
