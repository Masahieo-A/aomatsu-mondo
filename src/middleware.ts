// =============================================================================
// middleware : セッションのリフレッシュ + 未認証ガード
//   @supabase/ssr v0.12 の推奨パターン（getAll/setAll + getUser）。
//   - 全リクエストで getUser() を呼び、期限切れセッションを裏でリフレッシュする。
//   - 未認証ユーザーは /login へリダイレクト（/login と /auth/* は除外）。
//   - ホワイトリスト照合はここでは行わない（DBクエリを避けるため）。
//     各ページ/API 側で getAllowedUser() を使って照合する（設計判断）。
//   - 静的アセット等は下部の matcher で除外する。
// =============================================================================
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // supabase の setAll がここに cookie を書き戻すため let で保持する。
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // createServerClient と getUser の間に処理を挟まないこと（ssr の注意事項）。
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isAuthRoute =
    pathname === '/login' || pathname.startsWith('/auth');

  // 未認証で、ログイン系ルート以外にアクセスした場合は /login へ。
  if (!user && !isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // 重要: supabaseResponse をそのまま返す（cookie を保持するため）。
  return supabaseResponse;
}

export const config = {
  matcher: [
    // 静的アセット・画像・favicon を除く全パスに適用する。
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
