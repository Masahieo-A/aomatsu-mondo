import { describe, expect, it } from 'vitest';

import { buildJsonl, formatAnswerId, jstDateStamp, toExportRecord, toJstIso } from '../export';
import type { AnswerRow, ExportRecord, QuestionRow } from '../types';

// -----------------------------------------------------------------------------
// テスト用の最小行ビルダー（未指定フィールドはダミー値で埋める）
// -----------------------------------------------------------------------------
function makeAnswer(overrides: Partial<AnswerRow> = {}): AnswerRow {
  return {
    id: 'answer-uuid-1',
    seq: 123,
    question_id: 'q2_013',
    user_id: 'user-1',
    status: 'submitted',
    answer_text: '頼まれごとを断った場面…',
    reason_text: '理由…',
    choice: null,
    followup_q: null,
    followup_a: null,
    input_mode: 'voice_raw',
    skipped: false,
    skip_reason: null,
    revision_of: null,
    created_at: '2026-07-19T22:00:00Z',
    updated_at: '2026-07-19T22:45:00Z',
    submitted_at: '2026-07-19T22:45:00Z',
    ...overrides,
  };
}

function makeQuestion(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q2_013',
    category: 'Q2',
    body: '最近、頼まれごとを断った場面と理由は？',
    body_options: null,
    source: 'seed',
    status: 'approved',
    reject_reason: null,
    reask_after: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('formatAnswerId', () => {
  it('② seq を最低4桁ゼロ埋めした ans_ 形式に変換する', () => {
    expect(formatAnswerId(123)).toBe('ans_0123');
    expect(formatAnswerId(7)).toBe('ans_0007');
  });

  it('② 5桁以上はそのまま桁が増える', () => {
    expect(formatAnswerId(12345)).toBe('ans_12345');
  });
});

describe('toJstIso', () => {
  it('③ UTC → JST(+09:00) へ変換する（日付繰り上がりを含む）', () => {
    expect(toJstIso('2026-07-19T22:45:00Z')).toBe('2026-07-20T07:45:00+09:00');
  });

  it('③ ミリ秒なしで整形する', () => {
    expect(toJstIso('2026-07-19T22:45:00.123Z')).toBe('2026-07-20T07:45:00+09:00');
  });

  it('③ 日付が繰り上がらないケースも正しく整形する', () => {
    expect(toJstIso('2026-07-20T01:00:00Z')).toBe('2026-07-20T10:00:00+09:00');
  });
});

describe('toExportRecord', () => {
  it('① 要件定義書4.6の例と同じ入力からキーの集合・順序が完全一致する出力を作る', () => {
    const answer = makeAnswer({
      seq: 123,
      answer_text: '頼まれごとを断った場面…',
      reason_text: '断った理由…',
      followup_q: 'なぜそう感じたのですか？',
      followup_a: '深掘りへの回答…',
      input_mode: 'voice_raw',
      submitted_at: '2026-07-19T22:45:00Z', // JST 2026-07-20T07:45:00+09:00
      revision_of: null,
    });
    const question = makeQuestion({ id: 'q2_013', category: 'Q2' });

    const record = toExportRecord(answer, question, null);

    expect(Object.keys(record).sort()).toEqual(
      [
        'id',
        'category',
        'question',
        'answer',
        'reason',
        'followup_q',
        'followup_a',
        'layer',
        'topics',
        'register',
        'input_mode',
        'answered_at',
        'revision_of',
      ].sort(),
    );

    expect(record).toEqual<ExportRecord>({
      id: 'ans_0123',
      category: 'Q2',
      question: question.body,
      answer: '頼まれごとを断った場面…',
      reason: '断った理由…',
      followup_q: 'なぜそう感じたのですか？',
      followup_a: '深掘りへの回答…',
      layer: 'thinking',
      topics: [],
      register: 'private',
      input_mode: 'voice_raw',
      answered_at: '2026-07-20T07:45:00+09:00',
      revision_of: null,
    });
  });

  it('④ layer は CATEGORY_LAYER から導出される（Q2→thinking, Q4/Q6→style, Q7→knowledge）', () => {
    const cases: Array<[QuestionRow['category'], ExportRecord['layer']]> = [
      ['Q2', 'thinking'],
      ['Q4', 'style'],
      ['Q6', 'style'],
      ['Q7', 'knowledge'],
    ];

    for (const [category, layer] of cases) {
      const record = toExportRecord(makeAnswer(), makeQuestion({ category }), null);
      expect(record.layer).toBe(layer);
    }
  });

  it('⑤ topics は常に空配列、register は常に "private"', () => {
    const record = toExportRecord(makeAnswer(), makeQuestion(), null);
    expect(record.topics).toEqual([]);
    expect(record.register).toBe('private');
  });

  it('⑥ revision_of が無ければ null', () => {
    const record = toExportRecord(makeAnswer({ revision_of: null }), makeQuestion(), null);
    expect(record.revision_of).toBeNull();
  });

  it('⑥ revision_of があれば参照先の seq を ans_ 形式に変換する', () => {
    const record = toExportRecord(
      makeAnswer({ revision_of: 'answer-uuid-old' }),
      makeQuestion(),
      45, // 参照先回答の seq
    );
    expect(record.revision_of).toBe('ans_0045');
  });

  it('選択式（Q1/Q4）は answer に「choice: 選択肢本文」を書き出す（結論の欠落防止）', () => {
    const record = toExportRecord(
      makeAnswer({ answer_text: null, choice: 'A', reason_text: '理由…' }),
      makeQuestion({
        id: 'q1_001',
        category: 'Q1',
        body: '正確さと面白さ、片方削るならどっち？',
        body_options: { A: '正確さを削る', B: '面白さを削る' },
      }),
      null,
    );
    expect(record.answer).toBe('A: 正確さを削る');
    expect(record.reason).toBe('理由…');
  });

  it('選択式でも answer_text があればそちらを優先する', () => {
    const record = toExportRecord(
      makeAnswer({ answer_text: '自由記述の補足', choice: 'B' }),
      makeQuestion({ category: 'Q1', body_options: { A: 'a', B: 'b' } }),
      null,
    );
    expect(record.answer).toBe('自由記述の補足');
  });

  it('submitted_at が null なら例外を投げる（呼び出し側のフィルタ漏れ検出）', () => {
    expect(() =>
      toExportRecord(makeAnswer({ submitted_at: null }), makeQuestion(), null),
    ).toThrow();
  });
});

describe('buildJsonl', () => {
  it('⑦ 改行区切りで各行がJSONとしてパース可能', () => {
    const records: ExportRecord[] = [
      toExportRecord(makeAnswer({ seq: 1 }), makeQuestion(), null),
      toExportRecord(makeAnswer({ seq: 2 }), makeQuestion(), null),
    ];

    const jsonl = buildJsonl(records);
    const lines = jsonl.split('\n').filter((l) => l.length > 0);

    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines[0]).id).toBe('ans_0001');
    expect(JSON.parse(lines[1]).id).toBe('ans_0002');
  });

  it('⑦ 各行のキー順が要件定義書4.6の例と同一', () => {
    const record = toExportRecord(makeAnswer(), makeQuestion(), null);
    const jsonl = buildJsonl([record]);
    const line = jsonl.split('\n')[0];

    expect(Object.keys(JSON.parse(line))).toEqual([
      'id',
      'category',
      'question',
      'answer',
      'reason',
      'followup_q',
      'followup_a',
      'layer',
      'topics',
      'register',
      'input_mode',
      'answered_at',
      'revision_of',
    ]);
  });

  it('空配列からは空文字列を返す（0件エクスポートの空ボディ用）', () => {
    expect(buildJsonl([])).toBe('');
  });
});

describe('jstDateStamp', () => {
  it('UTC日時をJST基準のYYYYMMDDに変換する（日付繰り上がりを含む）', () => {
    expect(jstDateStamp(new Date('2026-07-19T22:45:00Z'))).toBe('20260720');
    expect(jstDateStamp(new Date('2026-07-19T10:00:00Z'))).toBe('20260719');
  });
});
