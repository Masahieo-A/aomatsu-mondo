'use client';

// =============================================================================
// SkipSheet : スキップ理由を1タップで選ぶボトムシート
//   3つの理由（答えたくない / 思いつかない / 質問が悪い）を大きなボタンで表示。
//   1タップで onSelect(reason) → 呼び出し側が skipQuestion を実行し次の質問へ移動する。
// =============================================================================
import { SKIP_REASONS, type SkipReason } from '@/lib/types';

export function SkipSheet({
  open,
  busy = false,
  onSelect,
  onClose,
}: {
  open: boolean;
  busy?: boolean;
  onSelect: (reason: SkipReason) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      {/* 背景オーバーレイ（タップで閉じる） */}
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative z-10 rounded-t-2xl bg-[var(--background)] p-4 pb-6 shadow-2xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        <p className="mb-3 text-center text-sm font-medium text-zinc-600 dark:text-zinc-300">
          スキップの理由を選んでください
        </p>
        <div className="flex flex-col gap-2">
          {SKIP_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              disabled={busy}
              onClick={() => onSelect(reason)}
              className="flex min-h-[52px] w-full items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-800 transition active:scale-[0.99] disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              {reason}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="mt-3 flex min-h-11 w-full items-center justify-center rounded-xl px-4 text-sm text-zinc-500 transition disabled:opacity-60 dark:text-zinc-400"
        >
          やめる
        </button>
      </div>
    </div>
  );
}
