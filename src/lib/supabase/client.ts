// =============================================================================
// ブラウザ用 Supabase クライアント（@supabase/ssr v0.12）
//   クライアントコンポーネントから使う。createBrowserClient は Cookie を
//   document.cookie 経由で自動同期するため、cookie ハンドラの指定は不要。
//   env はブラウザに埋め込まれる NEXT_PUBLIC_* のみを参照する。
// =============================================================================
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
