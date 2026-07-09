'use client';

// =============================================================================
// AnswerForm : 回答画面のクライアント本体（Stage 4）
//   Stage 3b の自動保存コア（createAutosaver）と answers ライブラリを統合する。
//
//   自動保存（最重要要件）の発火点:
//     ① 入力停止2秒後   … autosaver 内部の debounce（update で駆動）
//     ② blur           … textarea / 選択の onBlur で flush()
//     ③ 前後移動・一覧へ … navigate() が flush() してから router.push()
//     ④ visibilitychange(hidden) … document リスナで flush()（ブラウザを閉じる場合も拾う）
//     ⑤ unmount        … cleanup で flush() → dispose()
//
//   確定済み回答の編集は自動保存しない（mode='submitted' では autosave 無効）。
//   誤って本回答を中途半端に上書きする事故を防ぐため、明示的な「更新する」ボタン
//   （submitAnswer）だけが確定回答を書き換える（実装計画・指示の設計判断）。
// =============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { createClient } from '@/lib/supabase/client';
import {
  createSupabaseAnswersRepo,
  saveDraft,
  submitAnswer,
  skipQuestion,
  validateAnswer,
  type AnswerInput,
  type AnswersRepo,
} from '@/lib/answers';
import { createAutosaver, type Autosaver, type AutosaveStatus } from '@/lib/autosave';
import {
  CATEGORY_LABELS,
  CHOICE_CATEGORIES,
  REASON_MIN_LENGTH,
  type BodyOptions,
  type Category,
  type Choice,
  type SkipReason,
} from '@/lib/types';
import { formatQuestionId } from '@/lib/question-status';

import { ChoiceButtons } from './ChoiceButtons';
import { SkipSheet } from './SkipSheet';
import { SaveIndicator } from './SaveIndicator';
import { Toast, type ToastKind, type ToastState } from './Toast';

/** 画面の状態。answering=未確定（自動保存ON）/ submitted=確定済み編集（自動保存OFF）/ skipped=スキップ済み */
type Mode = 'answering' | 'submitted' | 'skipped';

export interface AnswerFormProps {
  questionId: string;
  category: Category;
  body: string;
  bodyOptions: BodyOptions | null;
  initialAnswerText: string;
  initialReasonText: string;
  initialChoice: Choice | null;
  initialMode: Mode;
  skipReason: SkipReason | null;
  prevHref: string | null;
  nextHref: string | null;
  listHref: string;
}

/** 理由/本文の文字数（バリデーションと同じ: trim 後の code point 単位）。 */
function charLen(text: string): number {
  return Array.from(text.trim()).length;
}

export function AnswerForm(props: AnswerFormProps) {
  const {
    questionId,
    category,
    body,
    bodyOptions,
    initialAnswerText,
    initialReasonText,
    initialChoice,
    initialMode,
    skipReason,
    prevHref,
    nextHref,
    listHref,
  } = props;

  const router = useRouter();
  const isChoice = CHOICE_CATEGORIES.includes(category);

  // --- 入力 state -----------------------------------------------------------
  const [answerText, setAnswerText] = useState(initialAnswerText);
  const [reasonText, setReasonText] = useState(initialReasonText);
  const [choice, setChoice] = useState<Choice | null>(initialChoice);
  const [mode, setMode] = useState<Mode>(initialMode);

  const [saveStatus, setSaveStatus] = useState<AutosaveStatus>('idle');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipBusy, setSkipBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const autosaveEnabled = mode === 'answering';

  // --- トースト -------------------------------------------------------------
  const toastId = useRef(0);
  const showToast = useCallback((message: string, kind: ToastKind) => {
    toastId.current += 1;
    setToast({ message, kind, id: toastId.current });
  }, []);

  // --- リポジトリ & autosaver -----------------------------------------------
  // autosaver は useState ではなく「マウント時に生成・アンマウント時に flush→dispose」
  // の effect + ref で持つ。React Strict Mode（devの検査用マウント→アンマウント→
  // 再マウント）では cleanup が本物のアンマウントと区別なく走るため、useState で
  // 1度だけ生成すると検査アンマウントで dispose された死んだインスタンスが残り、
  // 以後の自動保存が一切効かなくなる（実際に起きた不具合）。effect 生成なら
  // 再マウント時に新しいインスタンスが作られるので dev/本番とも正しく動く。
  const [repo] = useState<AnswersRepo>(() => createSupabaseAnswersRepo(createClient()));
  const autosaverRef = useRef<Autosaver<AnswerInput> | null>(null);

  useEffect(() => {
    const autosaver = createAutosaver<AnswerInput>(
      async (payload) => {
        await saveDraft(repo, questionId, payload);
      },
      {
        onStatusChange: (s) => {
          setSaveStatus(s);
          if (s === 'error') {
            showToast('保存に失敗しました（入力は保持されています）', 'error');
          }
        },
      },
    );
    autosaverRef.current = autosaver;

    // visibilitychange(hidden) で flush（ブラウザを閉じる場合も拾う）
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void autosaver.flush();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      autosaverRef.current = null;
      // アンマウント時は flush してから dispose（保存済み内容を失わない）
      void autosaver.flush().finally(() => autosaver.dispose());
    };
  }, [repo, questionId, showToast]);

  // --- 現在入力を AnswerInput へ（カテゴリに応じ必要フィールドのみ送る） -----
  function buildInput(nextChoice = choice, nextReason = reasonText, nextAnswer = answerText): AnswerInput {
    return isChoice
      ? { choice: nextChoice, reason_text: nextReason }
      : { answer_text: nextAnswer };
  }

  const validation = useMemo(
    () => validateAnswer(category, buildInput()),
    // buildInput は state に依存するため、依存配列に生の値を列挙
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [category, isChoice, choice, reasonText, answerText],
  );

  // --- 入力ハンドラ（autosave 有効時のみ update） ---------------------------
  function onAnswerChange(v: string) {
    setAnswerText(v);
    if (autosaveEnabled) autosaverRef.current?.update({ answer_text: v });
  }
  function onReasonChange(v: string) {
    setReasonText(v);
    if (autosaveEnabled) autosaverRef.current?.update(buildInput(choice, v));
  }
  function onSelectChoice(c: Choice) {
    setChoice(c);
    if (autosaveEnabled) autosaverRef.current?.update(buildInput(c, reasonText));
  }
  function onFieldBlur() {
    if (autosaveEnabled) void autosaverRef.current?.flush();
  }

  // --- ナビゲーション（flush してから push） --------------------------------
  async function navigate(href: string) {
    await autosaverRef.current?.flush();
    // 保存に失敗したまま遷移すると未保存の入力が失われるため、移動を中止して
    // 入力を保持する（「回答が失われる事態は絶対に避ける」= 要件 1.3）。
    if (autosaveEnabled && autosaverRef.current?.getStatus() === 'error') {
      showToast('保存に失敗したため移動を中止しました（入力は保持されています）', 'error');
      return;
    }
    router.push(href);
  }

  // --- 送信（確定 / 更新） --------------------------------------------------
  async function handleSubmit() {
    if (!validation.ok || submitting) return;
    setSubmitting(true);
    // 未確定なら保留中の下書きを先に確定してから submit（submitAnswer が draft 行を転用）
    if (autosaveEnabled) await autosaverRef.current?.flush();

    const wasEditing = mode === 'submitted';
    try {
      const result = await submitAnswer(repo, questionId, buildInput(), category);
      if (!result.ok) {
        showToast(result.errors.join(' / '), 'error');
        return;
      }
    } catch {
      showToast('送信に失敗しました。もう一度お試しください', 'error');
      return;
    } finally {
      setSubmitting(false);
    }

    setMode('submitted'); // 以後 autosave 無効。編集は「更新する」ボタン経由のみ
    showToast(wasEditing ? '回答を更新しました' : '回答を確定しました', 'success');
    router.refresh(); // 一覧バッジを即時更新
  }

  // --- スキップ -------------------------------------------------------------
  async function handleSkip(reason: SkipReason) {
    setSkipBusy(true);
    // 下書きがあれば skipQuestion がその行を転用するため、先に flush して確定させる
    if (autosaveEnabled) await autosaverRef.current?.flush();
    try {
      await skipQuestion(repo, questionId, reason);
    } catch {
      setSkipBusy(false);
      setSkipOpen(false);
      showToast('スキップに失敗しました', 'error');
      return;
    }
    autosaverRef.current?.dispose(); // 次の質問へ移動するので以後 autosave しない
    router.refresh();
    router.push(nextHref ?? listHref);
  }

  // ==========================================================================
  // 描画
  // ==========================================================================
  const reasonCount = charLen(reasonText);

  return (
    <main className="flex flex-1 flex-col">
      {/* ナビゲーション（前へ / 一覧 / 次へ）。遷移前に必ず flush する */}
      <nav className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <button
          type="button"
          disabled={!prevHref}
          onClick={() => prevHref && navigate(prevHref)}
          className={navBtnClass(!prevHref)}
        >
          ← 前へ
        </button>
        <button
          type="button"
          onClick={() => navigate(listHref)}
          className="flex min-h-11 items-center rounded-lg px-4 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 active:scale-[0.98] dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          一覧
        </button>
        <button
          type="button"
          disabled={!nextHref}
          onClick={() => nextHref && navigate(nextHref)}
          className={navBtnClass(!nextHref)}
        >
          次へ →
        </button>
      </nav>

      {/* 保存状態インジケータ */}
      <div className="flex min-h-6 items-center px-4 pt-2">
        <SaveIndicator status={saveStatus} />
      </div>

      <div className="flex flex-col gap-5 px-4 pb-28 pt-2">
        {/* 質問ヘッダー */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
              {CATEGORY_LABELS[category]}
            </span>
            <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500">
              {formatQuestionId(questionId)}
            </span>
          </div>
          <h1 className="text-base font-semibold leading-relaxed text-zinc-900 dark:text-zinc-50">
            {body}
          </h1>
        </div>

        {mode === 'skipped' ? (
          <SkippedView reason={skipReason} onRevive={() => setMode('answering')} />
        ) : (
          <>
            {/* 入力 */}
            {isChoice && bodyOptions ? (
              <div className="flex flex-col gap-4">
                <ChoiceButtons
                  options={bodyOptions}
                  value={choice}
                  onSelect={(c) => {
                    onSelectChoice(c);
                    onFieldBlur(); // 選択確定は blur 相当として即 flush
                  }}
                />
                <div>
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <label htmlFor="reason" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      理由（必須・{REASON_MIN_LENGTH}字以上）
                    </label>
                    <span
                      className={`text-xs ${
                        reasonCount >= REASON_MIN_LENGTH
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-zinc-400 dark:text-zinc-500'
                      }`}
                    >
                      現在 {reasonCount} 字
                    </span>
                  </div>
                  <AutoTextarea
                    id="reason"
                    value={reasonText}
                    onChange={onReasonChange}
                    onBlur={onFieldBlur}
                    placeholder="そう考える理由を書いてください"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label htmlFor="answer" className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  回答
                </label>
                <AutoTextarea
                  id="answer"
                  value={answerText}
                  onChange={onAnswerChange}
                  onBlur={onFieldBlur}
                  placeholder="自由に記述してください"
                  minRows={5}
                />
              </div>
            )}

            {/* バリデーションエラー表示 */}
            {!validation.ok && (
              <ul className="flex flex-col gap-1">
                {validation.errors.map((e) => (
                  <li key={e} className="text-xs text-amber-600 dark:text-amber-400">
                    {e}
                  </li>
                ))}
              </ul>
            )}

            {/* アクション */}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!validation.ok || submitting}
                className="flex min-h-12 w-full items-center justify-center rounded-xl bg-zinc-900 px-4 text-sm font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {submitting ? '送信中…' : mode === 'submitted' ? '更新する' : '回答を確定する'}
              </button>
              {mode !== 'submitted' && (
                <button
                  type="button"
                  onClick={() => setSkipOpen(true)}
                  className="flex min-h-11 w-full items-center justify-center rounded-xl px-4 text-sm text-zinc-500 transition hover:bg-zinc-100 active:scale-[0.99] dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  スキップ
                </button>
              )}
              {mode === 'submitted' && (
                <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">
                  確定済みです。編集後「更新する」で保存されます（自動保存はされません）
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <SkipSheet
        open={skipOpen}
        busy={skipBusy}
        onSelect={handleSkip}
        onClose={() => setSkipOpen(false)}
      />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </main>
  );
}

// -----------------------------------------------------------------------------
// スキップ済み表示
// -----------------------------------------------------------------------------
function SkippedView({
  reason,
  onRevive,
}: {
  reason: SkipReason | null;
  onRevive: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        この質問はスキップ済みです{reason ? `（理由: ${reason}）` : ''}。
      </p>
      <button
        type="button"
        onClick={onRevive}
        className="flex min-h-11 w-full items-center justify-center rounded-xl bg-zinc-900 px-4 text-sm font-semibold text-white transition active:scale-[0.99] dark:bg-zinc-100 dark:text-zinc-900"
      >
        やっぱり回答する
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// 自動で高さが伸びる textarea
// -----------------------------------------------------------------------------
function AutoTextarea({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  minRows = 3,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  placeholder?: string;
  minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      id={id}
      ref={ref}
      rows={minRows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      className="w-full resize-none rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-sm leading-relaxed text-zinc-900 outline-none transition focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-100 dark:focus:ring-zinc-100"
    />
  );
}

function navBtnClass(disabled: boolean): string {
  return `flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition active:scale-[0.98] ${
    disabled
      ? 'cursor-not-allowed text-zinc-300 dark:text-zinc-700'
      : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800'
  }`;
}
