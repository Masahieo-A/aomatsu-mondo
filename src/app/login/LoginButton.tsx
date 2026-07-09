'use client';

// =============================================================================
// Googleログインボタン（クライアントコンポーネント）
//   signInWithOAuth(provider: 'google') を呼び、Google の同意画面へ遷移する。
//   redirectTo は NEXT_PUBLIC_SITE_URL + /auth/callback（OAuthコールバック）。
// =============================================================================
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function LoginButton() {
  const [loading, setLoading] = useState(false);

  async function signInWithGoogle() {
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
      },
    });
    // 成功時は Google へリダイレクトするためここには戻らない。
    if (error) setLoading(false);
  }

  return (
    <button
      type="button"
      onClick={signInWithGoogle}
      disabled={loading}
      className="flex w-full items-center justify-center gap-3 rounded-xl border border-zinc-300 bg-white px-4 py-3.5 text-base font-medium text-zinc-800 shadow-sm transition active:scale-[0.99] disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <svg
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        className="shrink-0"
      >
        <path
          fill="#4285F4"
          d="M23.52 12.27c0-.82-.07-1.6-.2-2.36H12v4.47h6.47a5.53 5.53 0 0 1-2.4 3.63v3.01h3.88c2.27-2.09 3.57-5.17 3.57-8.75z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3.01c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.11A12 12 0 0 0 12 24z"
        />
        <path
          fill="#FBBC05"
          d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.29a12 12 0 0 0 0 10.78l3.98-3.11z"
        />
        <path
          fill="#EA4335"
          d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44A11.96 11.96 0 0 0 12 0 12 12 0 0 0 1.29 6.61l3.98 3.11C6.22 6.86 8.87 4.75 12 4.75z"
        />
      </svg>
      {loading ? 'リダイレクト中…' : 'Googleでログイン'}
    </button>
  );
}
