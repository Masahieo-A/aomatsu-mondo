// =============================================================================
// 認証 + ホワイトリスト照合の共通関数（サーバー側）
//   後続ステージ（一覧・回答・エクスポート）はこの getAllowedUser() を使って
//   「認証済み かつ allowed_emails に載っている」ユーザーだけを通す。
//
//   照合方法:
//     1. supabase.auth.getUser() で認証ユーザーを取得（未認証なら null）。
//     2. allowed_emails から自分のメール行を select。RLS の
//        allowed_emails_select ポリシー（email = auth.jwt()->>'email'）により
//        自分の行しか見えないため、0件 = 非許可 とみなせる。
//   未認証 / 非許可はいずれも null を返す。
// =============================================================================
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

export async function getAllowedUser(): Promise<User | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) return null;

  const { data, error } = await supabase
    .from('allowed_emails')
    .select('email')
    .eq('email', user.email)
    .maybeSingle();

  if (error || !data) return null;
  return user;
}
