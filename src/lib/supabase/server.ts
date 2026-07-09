// =============================================================================
// サーバー用 Supabase クライアント（@supabase/ssr v0.12）
//   サーバーコンポーネント / Route Handler から使う。
//   Next.js 16 の cookies() は async のため await して受け取る。
//   getAll / setAll の cookie パターンで実装（v0.12 推奨）。
// =============================================================================
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // サーバーコンポーネントから呼ばれた場合は cookie を書き込めない。
            // セッションのリフレッシュは middleware が担うため無視してよい。
          }
        },
      },
    },
  );
}
