import { describe, expect, it } from 'vitest';

import {
  canReask,
  reviseAnswer,
  saveDraft,
  skipQuestion,
  submitAnswer,
  validateAnswer,
  type AnswersRepo,
  type NewAnswer,
} from '../answers';
import type { AnswerRow } from '../types';

// -----------------------------------------------------------------------------
// インメモリのモックリポジトリ（Supabase の代わり）
// -----------------------------------------------------------------------------
function createFakeRepo(seed: AnswerRow[] = []) {
  const rows: AnswerRow[] = [...seed];
  let counter = seed.length;

  const now = () => new Date().toISOString();

  const repo: AnswersRepo = {
    async findDraft(questionId) {
      return (
        rows.find((r) => r.question_id === questionId && r.status === 'draft') ?? null
      );
    },
    async findSubmitted(questionId) {
      const subs = rows.filter(
        (r) =>
          r.question_id === questionId &&
          r.status === 'submitted' &&
          r.revision_of === null,
      );
      return subs.length ? subs[subs.length - 1] : null;
    },
    async insert(input: NewAnswer) {
      counter += 1;
      const row: AnswerRow = {
        id: `id-${counter}`,
        seq: counter,
        question_id: input.question_id,
        user_id: 'user-1',
        status: input.status,
        answer_text: input.answer_text ?? null,
        reason_text: input.reason_text ?? null,
        choice: input.choice ?? null,
        followup_q: null,
        followup_a: null,
        input_mode: 'text',
        skipped: input.skipped ?? false,
        skip_reason: input.skip_reason ?? null,
        revision_of: input.revision_of ?? null,
        created_at: now(),
        updated_at: now(),
        submitted_at: input.submitted_at ?? null,
      };
      rows.push(row);
      return row;
    },
    async update(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) throw new Error(`row not found: ${id}`);
      rows[i] = { ...rows[i], ...patch, updated_at: now() };
      return rows[i];
    },
  };

  return { repo, rows };
}

describe('saveDraft', () => {
  it('① draft が無ければ新規作成する', async () => {
    const { repo, rows } = createFakeRepo();
    const r = await saveDraft(repo, 'q2_001', { answer_text: '書きかけ' });

    expect(r.status).toBe('draft');
    expect(r.answer_text).toBe('書きかけ');
    expect(rows.length).toBe(1);
  });

  it('① 既存 draft があれば新規作成せず更新する', async () => {
    const { repo, rows } = createFakeRepo();
    const first = await saveDraft(repo, 'q2_001', { answer_text: '途中1' });
    const second = await saveDraft(repo, 'q2_001', { answer_text: '途中2' });

    expect(rows.length).toBe(1); // 行は増えない
    expect(second.id).toBe(first.id);
    expect(second.answer_text).toBe('途中2');
  });
});

describe('submitAnswer', () => {
  it('② draft → submitted へ遷移し submitted_at を記録する', async () => {
    const { repo, rows } = createFakeRepo();
    await saveDraft(repo, 'q2_001', { answer_text: '回答' });

    const res = await submitAnswer(repo, 'q2_001', { answer_text: '回答' }, 'Q2');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.answer.status).toBe('submitted');
      expect(res.answer.submitted_at).toBeTruthy();
    }
    expect(rows.length).toBe(1); // draft が転用され新規行は増えない
  });

  it('② draft も submitted も無ければ submitted 行を新規作成する', async () => {
    const { repo, rows } = createFakeRepo();
    const res = await submitAnswer(repo, 'q2_002', { answer_text: '直接送信' }, 'Q2');

    expect(res.ok).toBe(true);
    expect(rows.length).toBe(1);
    if (res.ok) expect(res.answer.status).toBe('submitted');
  });

  it('② 既存 submitted の編集では submitted_at を変えない', async () => {
    const { repo } = createFakeRepo();
    const first = await submitAnswer(repo, 'q2_003', { answer_text: '初回' }, 'Q2');
    expect(first.ok).toBe(true);
    const submittedAt = first.ok ? first.answer.submitted_at : null;

    const edit = await submitAnswer(repo, 'q2_003', { answer_text: '編集後' }, 'Q2');
    expect(edit.ok).toBe(true);
    if (edit.ok) {
      expect(edit.answer.answer_text).toBe('編集後');
      expect(edit.answer.submitted_at).toBe(submittedAt); // 変わらない
    }
  });

  it('バリデーション失敗時は書き込まずエラーを返す', async () => {
    const { repo, rows } = createFakeRepo();
    const res = await submitAnswer(repo, 'q1_001', { choice: null }, 'Q1');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
    expect(rows.length).toBe(0);
  });
});

describe('validateAnswer', () => {
  it('③ Q1: choice が無ければ拒否', () => {
    const res = validateAnswer('Q1', { reason_text: 'あ'.repeat(20) });
    expect(res.ok).toBe(false);
  });

  it('③ Q1: 理由19字は拒否、20字は受理', () => {
    const short = validateAnswer('Q1', { choice: 'A', reason_text: 'あ'.repeat(19) });
    expect(short.ok).toBe(false);

    const ok = validateAnswer('Q1', { choice: 'A', reason_text: 'あ'.repeat(20) });
    expect(ok.ok).toBe(true);
  });

  it('③ Q2: answer_text が空なら拒否、非空なら受理', () => {
    expect(validateAnswer('Q2', { answer_text: '' }).ok).toBe(false);
    expect(validateAnswer('Q2', { answer_text: '   ' }).ok).toBe(false); // 空白のみも空扱い
    expect(validateAnswer('Q2', { answer_text: '意見あり' }).ok).toBe(true);
  });

  it('Q4 も Q1 と同様に choice + 理由20字が必要', () => {
    expect(validateAnswer('Q4', { choice: 'B', reason_text: 'い'.repeat(20) }).ok).toBe(
      true,
    );
    expect(validateAnswer('Q4', { choice: 'B', reason_text: '短い' }).ok).toBe(false);
  });
});

describe('skipQuestion', () => {
  it('④ skip_reason を記録し status=submitted で保存する', async () => {
    const { repo, rows } = createFakeRepo();
    const r = await skipQuestion(repo, 'q3_001', '答えたくない');

    expect(r.skipped).toBe(true);
    expect(r.skip_reason).toBe('答えたくない');
    expect(r.status).toBe('submitted');
    expect(r.submitted_at).toBeTruthy();
    expect(rows.length).toBe(1);
  });

  it('④ 書きかけ draft があれば転用する（新規行を増やさない）', async () => {
    const { repo, rows } = createFakeRepo();
    const draft = await saveDraft(repo, 'q3_002', { answer_text: '書きかけ' });
    const r = await skipQuestion(repo, 'q3_002', '思いつかない');

    expect(r.id).toBe(draft.id); // draft を転用
    expect(r.skipped).toBe(true);
    expect(r.status).toBe('submitted');
    expect(rows.length).toBe(1);
  });
});

describe('reviseAnswer', () => {
  it('⑤ 旧行を変更せず revision_of を持つ新しい submitted 行を作る', async () => {
    const { repo, rows } = createFakeRepo();
    const first = await submitAnswer(repo, 'q3_001', { answer_text: '旧意見' }, 'Q3');
    expect(first.ok).toBe(true);
    const prevId = first.ok ? first.answer.id : '';

    const rev = await reviseAnswer(
      repo,
      'q3_001',
      prevId,
      { answer_text: '新意見' },
      'Q3',
    );

    expect(rev.ok).toBe(true);
    if (rev.ok) {
      expect(rev.answer.id).not.toBe(prevId);
      expect(rev.answer.revision_of).toBe(prevId);
      expect(rev.answer.answer_text).toBe('新意見');
    }

    // 旧行は不変
    const old = rows.find((r) => r.id === prevId);
    expect(old?.answer_text).toBe('旧意見');
    expect(old?.revision_of).toBe(null);
    expect(rows.length).toBe(2); // 旧 + 新
  });

  it('バリデーション失敗時は新行を作らない', async () => {
    const { repo, rows } = createFakeRepo();
    const res = await reviseAnswer(repo, 'q1_001', 'id-prev', { choice: null }, 'Q1');
    expect(res.ok).toBe(false);
    expect(rows.length).toBe(0);
  });
});

describe('canReask', () => {
  const submittedAt = '2026-01-01T00:00:00+09:00';

  it('⑥ 6ヶ月未満は false', () => {
    expect(canReask(submittedAt, new Date('2026-05-01T00:00:00+09:00'))).toBe(false);
    expect(canReask(submittedAt, new Date('2026-06-30T00:00:00+09:00'))).toBe(false);
  });

  it('⑥ 6ヶ月以上は true', () => {
    expect(canReask(submittedAt, new Date('2026-07-01T00:00:00+09:00'))).toBe(true);
    expect(canReask(submittedAt, new Date('2027-01-01T00:00:00+09:00'))).toBe(true);
  });
});
