// =============================================================================
// OAuth コールバック : code を session に交換 + ホワイトリスト照合
//   1. Google OAuth 後、?code= 付きでここへ戻る。
//   2. exchangeCodeForSession で session cookie を確立する。
//   3. getAllowedUser() で allowed_emails 照合。許可なら / へ。
//   4. 非許可（または交換失敗）なら signOut して /login?error=not_allowed へ。
//   ※ ホワイトリスト外のアカウントに session を残さないよう必ず signOut する。
// =============================================================================
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getAllowedUser } from '@/lib/auth';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // 同一リクエスト内で session cookie が確立済みのため照合できる。
      const user = await getAllowedUser();
      if (user) {
        return NextResponse.redirect(`${origin}/`);
      }
      // 認証は成功したがホワイトリスト外 → session を破棄する。
      await supabase.auth.signOut();
    }
  }

  return NextResponse.redirect(`${origin}/login?error=not_allowed`);
}
