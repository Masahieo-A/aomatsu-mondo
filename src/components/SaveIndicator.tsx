'use client';

// =============================================================================
// SaveIndicator : 自動保存の状態を画面上部に小さく表示する（最重要要件の可視化）
//   createAutosaver の onStatusChange から渡る AutosaveStatus をそのまま表示する。
//   error 状態は「入力は保持されています」を明示して消えない（トーストは別途数秒で消える）。
// =============================================================================
import type { AutosaveStatus } from '@/lib/autosave';

const LABELS: Partial<Record<AutosaveStatus, string>> = {
  pending: '保存中…',
  saving: '保存中…',
  saved: '保存済み ✓',
  error: '保存に失敗しました（入力は保持されています）',
};

export function SaveIndicator({ status }: { status: AutosaveStatus }) {
  const label = LABELS[status];
  if (!label) return <span className="text-xs text-transparent select-none">·</span>;

  const isError = status === 'error';
  const isSaved = status === 'saved';
  const color = isError
    ? 'text-red-600 dark:text-red-400'
    : isSaved
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-zinc-400 dark:text-zinc-500';

  return (
    <span className={`text-xs ${color}`} role="status" aria-live="polite">
      {label}
    </span>
  );
}
