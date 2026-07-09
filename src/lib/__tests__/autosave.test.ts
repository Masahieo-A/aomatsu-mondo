import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAutosaver, type AutosaveStatus } from '../autosave';

// マイクロタスクを条件成立まで送るヘルパ（fake timers に依存しない）。
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error('waitFor: 条件が成立しませんでした');
}

/** 外部から解決/拒否できる save モックを作る（save 中の割り込みテスト用） */
function createDeferredSave<T>() {
  const controls: Array<{
    resolve: () => void;
    reject: (e: unknown) => void;
  }> = [];
  const save = vi.fn((_payload: T) => {
    return new Promise<void>((resolve, reject) => {
      controls.push({ resolve, reject });
    });
  });
  return { save, controls };
}

describe('createAutosaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('① 入力停止から2秒後に save が発火する', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const a = createAutosaver<{ answer_text: string }>(save);

    a.update({ answer_text: 'あ' });
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1999);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ answer_text: 'あ' });
    expect(a.getStatus()).toBe('saved');
  });

  it('② 2秒以内の連続入力ではタイマーがリセットされ1回だけ保存される', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const a = createAutosaver<{ answer_text: string }>(save);

    a.update({ answer_text: 'A' });
    await vi.advanceTimersByTimeAsync(1000);
    a.update({ answer_text: 'AB' });
    await vi.advanceTimersByTimeAsync(1000);
    // 最後の入力から2秒経っていないのでまだ発火しない
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ answer_text: 'AB' });
  });

  it('③ flush で保留中の内容を即時保存する', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const a = createAutosaver<{ answer_text: string }>(save);

    a.update({ answer_text: 'X' });
    await a.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ answer_text: 'X' });

    // flush 済みなので後からタイマーが発火しても二重保存しない
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('保留が無い状態の flush は何もしない', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const a = createAutosaver<{ answer_text: string }>(save);

    await a.flush();
    expect(save).not.toHaveBeenCalled();
    expect(a.getStatus()).toBe('idle');
  });

  it('④ save 中に来た update は、完了後に最新内容で再保存される（last-write-wins）', async () => {
    const { save, controls } = createDeferredSave<{ answer_text: string }>();
    const a = createAutosaver<{ answer_text: string }>(save);

    a.update({ answer_text: 'first' });
    const flushed = a.flush(); // save(first) が実行中になる

    await waitFor(() => save.mock.calls.length === 1);
    expect(save).toHaveBeenNthCalledWith(1, { answer_text: 'first' });

    // save(first) 実行中に新しい入力
    a.update({ answer_text: 'second' });
    controls[0].resolve(); // save(first) 完了

    await waitFor(() => save.mock.calls.length === 2);
    expect(save).toHaveBeenNthCalledWith(2, { answer_text: 'second' });

    controls[1].resolve();
    await flushed;
    expect(save).toHaveBeenCalledTimes(2);
    expect(a.getStatus()).toBe('saved');
  });

  it('⑤ 直近で保存成功したのと同一内容は再保存しない', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const a = createAutosaver<{ answer_text: string }>(save);

    a.update({ answer_text: '同じ' });
    await a.flush();
    expect(save).toHaveBeenCalledTimes(1);

    // 内容が同一（別オブジェクトだが深く等しい）→ 保存しない
    a.update({ answer_text: '同じ' });
    await a.flush();
    expect(save).toHaveBeenCalledTimes(1);

    // 内容が変われば保存する
    a.update({ answer_text: '違う' });
    await a.flush();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('⑥ save 失敗時は状態が error になり内容を保持、次の flush でリトライ成功する', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    const statuses: AutosaveStatus[] = [];
    const a = createAutosaver<{ answer_text: string }>(save, {
      onStatusChange: (s) => statuses.push(s),
    });

    a.update({ answer_text: 'keep-me' });
    await a.flush(); // 1回目: 失敗
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.getStatus()).toBe('error');
    expect(statuses).toContain('error');

    // 保留内容は破棄されていない → 同じ内容でリトライされる
    await a.flush(); // 2回目: 成功
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, { answer_text: 'keep-me' });
    expect(a.getStatus()).toBe('saved');
  });

  it('⑦ dispose 後はタイマーが発火しない', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const a = createAutosaver<{ answer_text: string }>(save);

    a.update({ answer_text: 'gone' });
    a.dispose();

    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();

    // dispose 後の update も無反応
    a.update({ answer_text: 'still gone' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
  });
});
