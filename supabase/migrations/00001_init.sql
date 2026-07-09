-- =============================================================================
-- 青松問答 v1.0  初期スキーマ (00001_init.sql)
-- Postgres 15+ / Supabase 前提。gen_random_uuid() はビルトイン（pgcrypto不要）。
--
-- 収録内容:
--   - allowed_emails : ログイン許可メールのホワイトリスト
--   - questions      : 質問バンク（seed 350問 + 将来のLLM生成/欠落検出）
--   - answers        : 回答（draft/submitted、途中保存・再回答・スキップ対応）
--   - coverage       : カテゴリ別カバレッジ view
--   - RLS            : 全テーブル有効化。is_allowed() でホワイトリスト照合
-- =============================================================================


-- -----------------------------------------------------------------------------
-- allowed_emails : ログイン許可メールのホワイトリスト
-- -----------------------------------------------------------------------------
-- RLS ポリシーから auth.jwt()->>'email' を照合するために使う。env ではRLSから
-- 参照できないためテーブルで持つ。
--
-- ▼セットアップ手順（マイグレーション適用後、Supabase SQL Editor で1回だけ実行）:
--     insert into allowed_emails (email) values ('あなたのGoogleアカウントのメール');
--   例:
--     -- insert into allowed_emails (email) values ('aomatsu.masahiro@gmail.com');
--   ※ ここに含まれないメールでOAuthログインしても RLS で全データが不可視になる。
-- -----------------------------------------------------------------------------
create table allowed_emails (
  email text primary key
);


-- -----------------------------------------------------------------------------
-- questions : 質問バンク
-- -----------------------------------------------------------------------------
create table questions (
  id            text primary key,                                       -- 'q1_001' 形式（カテゴリ+連番、seed差し替え耐性）
  category      text not null check (category in ('Q1','Q2','Q3','Q4','Q5','Q6','Q7')),
  body          text not null,
  body_options  jsonb,                                                  -- Q1/Q4用 {"A":"...","B":"..."}。他カテゴリは null
  source        text not null default 'seed'
                  check (source in ('seed','llm','gap_detection')),
  status        text not null default 'approved'
                  check (status in ('draft','approved','rejected')),
  reject_reason text,
  reask_after   date,                                                   -- 再出題用（Q1/Q3の6ヶ月後 等）
  created_at    timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- answers : 回答
-- -----------------------------------------------------------------------------
create table answers (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,                     -- export id "ans_%04d" 用の連番
  question_id  text not null references questions(id),
  user_id      uuid not null references auth.users(id) default auth.uid(),
  status       text not null default 'draft'
                 check (status in ('draft','submitted')),
  answer_text  text,
  reason_text  text,
  choice       text,                                                    -- 'A' | 'B'（Q1/Q4）
  followup_q   text,                                                    -- v1.1用（カラムのみ）
  followup_a   text,                                                    -- v1.1用（カラムのみ）
  input_mode   text not null default 'text'
                 check (input_mode in ('text','voice_raw','voice_edited')),
  skipped      boolean not null default false,
  skip_reason  text check (skip_reason in ('答えたくない','思いつかない','質問が悪い')),
  revision_of  uuid references answers(id),                             -- 再回答の旧回答参照（自己参照）
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  submitted_at timestamptz
);

-- 質問ごとにアクティブな下書きは常に1つ（自動保存はこの行への upsert）。
-- submitted 行は複数（再回答チェーン）あり得るので status='draft' に限定した部分ユニーク。
create unique index answers_one_draft_per_question
  on answers(question_id)
  where status = 'draft';

-- 一覧/エクスポートで頻用する参照のための補助インデックス
create index answers_question_id_idx on answers(question_id);
create index answers_user_id_idx on answers(user_id);


-- -----------------------------------------------------------------------------
-- updated_at 自動更新トリガー
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger answers_set_updated_at
  before update on answers
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- coverage view : カテゴリ別カバレッジ
--   - answered_count : submitted かつ not skipped の回答数
--   - draft_count    : draft の回答数
--   - target_count   : 要件定義書 3.1 の初期目標問数
-- 全7カテゴリが（回答ゼロでも）常に1行として出るよう、目標問数をベースに questions/
-- answers を left join して集計する。
-- security_invoker=on にして、閲覧ユーザーの RLS を尊重する（本アプリはシングル
-- ユーザーだが、view が answers の RLS をバイパスしないようにするため）。
-- -----------------------------------------------------------------------------
create view coverage
with (security_invoker = on)
as
with targets(category, target_count) as (
  values
    ('Q1', 60),
    ('Q2', 50),
    ('Q3', 60),
    ('Q4', 40),
    ('Q5', 60),
    ('Q6', 40),
    ('Q7', 40)
)
select
  t.category,
  -- 再回答（revision_of チェーン）で同一質問に複数の submitted 行があり得るため、
  -- 「回答済みの質問数」として question_id の distinct でカウントする。
  count(distinct a.question_id) filter (where a.status = 'submitted' and not a.skipped) as answered_count,
  count(a.id)                   filter (where a.status = 'draft')                       as draft_count,
  t.target_count
from targets t
left join questions q on q.category = t.category
left join answers   a on a.question_id = q.id
group by t.category, t.target_count
order by t.category;


-- -----------------------------------------------------------------------------
-- is_allowed() : 認証ユーザーのメールがホワイトリストに存在するか
--   security definer にして、allowed_emails の RLS をバイパスして照合できるように
--   する（allowed_emails 自体の select ポリシーは「自分の行のみ」なので、ここで
--   security definer を使わないとポリシー内で参照できない）。
-- -----------------------------------------------------------------------------
create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from allowed_emails
    where email = (auth.jwt() ->> 'email')
  );
$$;


-- =============================================================================
-- Row Level Security
--   - 全テーブルで有効化
--   - ポリシーは `to authenticated` に限定 → anon ロールにはポリシーが一切当たらず
--     アクセス不可（RLSデフォルトは deny）。加えて下でテーブル権限も anon から revoke。
--   - questions      : select のみ
--   - answers        : select / insert / update（delete なし）。user_id = auth.uid() を担保
--   - allowed_emails : select のみ（自分のemail照合用）
-- =============================================================================
alter table allowed_emails enable row level security;
alter table questions      enable row level security;
alter table answers        enable row level security;

-- questions: 許可ユーザーは全質問を閲覧のみ
create policy questions_select on questions
  for select
  to authenticated
  using (is_allowed());

-- answers: 自分の回答のみ select
create policy answers_select on answers
  for select
  to authenticated
  using (is_allowed() and user_id = auth.uid());

-- answers: insert 時に user_id が自分（auth.uid()）であることを担保
create policy answers_insert on answers
  for insert
  to authenticated
  with check (is_allowed() and user_id = auth.uid());

-- answers: 自分の回答のみ update。update 後も user_id が自分であることを担保
create policy answers_update on answers
  for update
  to authenticated
  using (is_allowed() and user_id = auth.uid())
  with check (is_allowed() and user_id = auth.uid());

-- allowed_emails: 自分のメール行のみ select（照合用）
create policy allowed_emails_select on allowed_emails
  for select
  to authenticated
  using (email = (auth.jwt() ->> 'email'));


-- -----------------------------------------------------------------------------
-- テーブル権限（RLSに加えた二重の防御）
--   Supabase のデフォルト権限で anon/authenticated に付与され得るため、anon からは
--   明示的に revoke し、authenticated には必要最小限のみ grant する。
--   service_role は RLS/権限をバイパスするため seed 投入に支障なし。
-- -----------------------------------------------------------------------------
revoke all on allowed_emails from anon;
revoke all on questions      from anon;
revoke all on answers        from anon;
revoke all on coverage       from anon;

grant select                 on allowed_emails to authenticated;
grant select                 on questions      to authenticated;
grant select, insert, update on answers        to authenticated;
grant select                 on coverage       to authenticated;
