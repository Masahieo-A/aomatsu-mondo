'use client';

// =============================================================================
// ChoiceButtons : Q1/Q4 の A/B を大きな選択ボタンで表示する
//   body_options.A / .B のテキストを併記。選択後に blur 相当の flush を促すため
//   onCommit（= flush）を呼ぶ。タップターゲットは十分な高さを確保する。
// =============================================================================
import type { BodyOptions, Choice } from '@/lib/types';

export function ChoiceButtons({
  options,
  value,
  onSelect,
  disabled = false,
}: {
  options: BodyOptions;
  value: Choice | null;
  onSelect: (choice: Choice) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3" role="radiogroup" aria-label="選択肢">
      {(['A', 'B'] as const).map((key) => {
        const selected = value === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onSelect(key)}
            className={`flex min-h-[64px] w-full items-start gap-3 rounded-xl border-2 px-4 py-3 text-left transition active:scale-[0.99] disabled:opacity-60 ${
              selected
                ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                : 'border-zinc-300 bg-white text-zinc-800 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600'
            }`}
          >
            <span
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                selected
                  ? 'bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100'
                  : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
            >
              {key}
            </span>
            <span className="min-w-0 flex-1 text-sm leading-relaxed">{options[key]}</span>
          </button>
        );
      })}
    </div>
  );
}
