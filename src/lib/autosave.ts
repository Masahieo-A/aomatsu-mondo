// =============================================================================
// 青松問答 v1.0  自動保存ステートマシン（最重要要件）
//   要件定義書 4.2「途中保存（必須要件）」／ 設計は plans/joyful-mixing-hopcroft.md
//
//   DOM / React に一切依存しない純粋ロジック。UI 層（回答画面）はこれを生成し、
//   textarea の onChange で update()、blur / 画面遷移 / visibilitychange で flush()
//   を呼ぶ。保存先（Supabase の draft 行 upsert）は save コールバックとして注入する。
//
//   設計の要点:
//     - debounce: 最後の入力から delayMs（既定 2000ms）後に save を発火。
//     - last-write-wins: save 実行中に新しい入力が来たら、完了後に最新内容で再保存。
//       シングルユーザーなので「最後の入力が正」で安全（計画の判断）。
//     - 重複排除: 直近で保存成功した内容と深く等しい入力は再保存しない。
//     - 失敗時は絶対に保留内容を破棄しない（回答喪失を避けるのが本アプリの至上命題）。
//       状態を error にして UI にトースト表示させ、次の update()/flush() で自動リトライ。
// =============================================================================

/** 保存インジケータ / トーストが参照する状態 */
export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface AutosaverOptions {
  /** 入力停止からこの時間（ms）後に save 発火。既定 2000ms（要件定義書 4.2） */
  delayMs?: number;
  /** 状態が変化したときに通知（UI の保存インジケータ・トースト用） */
  onStatusChange?: (status: AutosaveStatus) => void;
}

export interface Autosaver<T> {
  /** 最新入力を受け取り、debounce タイマーをリセットする */
  update(payload: T): void;
  /** 保留中の内容を即時保存する。保留が無ければ何もしない */
  flush(): Promise<void>;
  /** タイマーを破棄する。以後 update しても発火しない */
  dispose(): void;
  /** 現在の状態を取得（テスト・UI 補助用） */
  getStatus(): AutosaveStatus;
}

/** 保留中の入力（null 判定と参照同一性で last-write-wins を判定するため box 化） */
interface Pending<T> {
  payload: T;
}

/**
 * 自動保存ステートマシンを生成する。
 *
 * 状態遷移の概略:
 *   idle ──update──▶ pending ──(delayMs 経過)/flush──▶ saving
 *   saving ──成功──▶ saved（保留が残っていれば saving に留まり再保存）
 *   saving ──失敗──▶ error（保留は保持。次の update/flush で saving に戻ってリトライ）
 */
export function createAutosaver<T>(
  save: (payload: T) => Promise<void>,
  options: AutosaverOptions = {},
): Autosaver<T> {
  const delayMs = options.delayMs ?? 2000;
  const onStatusChange = options.onStatusChange;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Pending<T> | null = null; // 未保存の最新入力（null = 保存すべきものは無い）
  let lastSaved: { payload: T } | null = null; // 直近で保存成功した内容（重複排除用）
  let draining: Promise<void> | null = null; // 実行中の保存ループ（多重起動防止）
  let status: AutosaveStatus = 'idle';
  let disposed = false;

  function setStatus(next: AutosaveStatus): void {
    if (status === next) return;
    status = next;
    onStatusChange?.(next);
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * 保留内容を保存し切るループ。
   *   - 実行中（draining）なら同じ Promise を返す。ループ側が最新 pending を拾うので
   *     last-write-wins が成立する。
   *   - 保留が無ければ何もしない（flush の「保留が無ければ何もしない」を満たす）。
   */
  async function run(): Promise<void> {
    setStatus('saving');
    while (pending !== null) {
      const current: Pending<T> = pending;
      // 直近保存成功と同一内容なら保存しない（重複排除）。
      if (lastSaved !== null && deepEqual(current.payload, lastSaved.payload)) {
        pending = null;
        break;
      }
      try {
        await save(current.payload);
      } catch {
        // 保存失敗: 保留内容は破棄しない（回答喪失を防ぐ最重要ポイント）。
        // error 状態にして UI にトースト表示させ、次の update/flush でリトライする。
        setStatus('error');
        return;
      }
      lastSaved = { payload: current.payload };
      // 保存中に新しい update が来ていれば pending は別オブジェクトを指す。
      // その場合はクリアせずループを続け、最新内容で再保存する（last-write-wins）。
      if (pending === current) {
        pending = null;
      }
    }
    if (!disposed) setStatus('saved');
  }

  function drain(): Promise<void> {
    if (draining) return draining;
    if (pending === null) return Promise.resolve();

    // draining のクリアは .finally（マイクロタスク）で行う。run() が同期完了（重複排除
    // で save を1度も await しない場合）でも、代入 draining=... の後にクリアが走るため、
    // 「finally が代入より先に走って draining が消えない」問題を避けられる。
    draining = run().finally(() => {
      draining = null;
    });
    return draining;
  }

  function update(payload: T): void {
    if (disposed) return;
    pending = { payload };
    clearTimer();
    // 保存中は 'saving' 表示を維持し、そうでなければ 'pending'。
    setStatus(draining ? 'saving' : 'pending');
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delayMs);
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    clearTimer();
    await drain();
  }

  function dispose(): void {
    disposed = true;
    clearTimer();
    // 進行中の保存は完了させる（保存済み内容を無かったことにしない）。
    // 以後 update() は disposed ガードで無反応、タイマーも張らない。
  }

  function getStatus(): AutosaveStatus {
    return status;
  }

  return { update, flush, dispose, getStatus };
}

/**
 * 保存内容の重複判定用の深い等価比較。
 * payload は { answer_text, reason_text, choice } のような素の値・オブジェクトを想定。
 * JSON.stringify はキー順序に依存するため、構造的に比較する。
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const arrA = Array.isArray(a);
  const arrB = Array.isArray(b);
  if (arrA !== arrB) return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
