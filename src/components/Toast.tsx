'use client';

// =============================================================================
// Toast : 画面下部に数秒だけ出る通知（送信成功 / 保存失敗など）
//   error 種別でも自動で消える（保存状態の恒久表示は SaveIndicator が担う）。
// =============================================================================
import { useEffect } from 'react';

export type ToastKind = 'success' | 'error';

export interface ToastState {
  message: string;
  kind: ToastKind;
  /** 同じ内容でも再表示できるよう毎回インクリメントする識別子 */
  id: number;
}

export function Toast({
  toast,
  onDismiss,
  durationMs = 3000,
}: {
  toast: ToastState | null;
  onDismiss: () => void;
  durationMs?: number;
}) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
    // toast.id が変わるたびにタイマーを張り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id]);

  if (!toast) return null;

  const color =
    toast.kind === 'error'
      ? 'bg-red-600 text-white'
      : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900';

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        role="alert"
        className={`pointer-events-auto max-w-sm rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${color}`}
      >
        {toast.message}
      </div>
    </div>
  );
}
