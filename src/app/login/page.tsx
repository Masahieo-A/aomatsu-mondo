// =============================================================================
// ログイン画面（モバイルファースト / 375px 基準）
//   アプリ名「青松問答」+ Googleログインボタンのみのシンプルな画面。
//   ?error=not_allowed が付いていたら「許可されていません」を表示する。
//   サーバーコンポーネントで searchParams を読み、ボタンだけ client に切り出す。
// =============================================================================
import { LoginButton } from './LoginButton';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const notAllowed = error === 'not_allowed';

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">青松問答</h1>
          <p className="mt-2 text-sm text-zinc-500">
            許可されたアカウントでログインしてください
          </p>
        </div>

        {notAllowed && (
          <div
            role="alert"
            className="mb-6 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
          >
            このアカウントは許可されていません
          </div>
        )}

        <LoginButton />
      </div>
    </main>
  );
}
