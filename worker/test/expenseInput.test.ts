/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isId, parseCreateExpense, parseUpdateExpense } from '../src/expenseInput.ts';

const valid = {
  expenseDate: '2026-11-19',
  targetMonth: '2026-11',
  description: 'スーパー',
  amountMinor: 4280,
  categoryId: 'category-1',
  payerMemberId: 'member-1',
  split: { method: 'category' },
};

const create = (overrides: Record<string, unknown>) => parseCreateExpense({ ...valid, ...overrides });
const failedField = (result: ReturnType<typeof parseCreateExpense>) => (result.ok ? null : result.field);

describe('支出の登録の入力', () => {
  it('正しい入力を読む', () => {
    const result = parseCreateExpense(valid);
    assert.ok(result.ok);
    // id は任意。無ければ null（Workerが決める）。
    assert.deepEqual(result.value, { ...valid, id: null, split: { method: 'category' } });
  });

  it('id（アプリが作る、登録の識別子）は任意。UUID（小文字）だけを受け付ける', () => {
    const uuid = '3f2b8c1e-9d4a-4e7b-8a61-5c0d2f7e9b14';
    const result = create({ id: uuid });
    assert.ok(result.ok);
    assert.equal(result.value.id, uuid);
    for (const id of ['', 'a b', 'あ', '1', 'expense-1_A', 'x'.repeat(65), uuid.toUpperCase(), uuid.replaceAll('-', ''), `${uuid}0`, 1, null, {}]) {
      assert.equal(failedField(create({ id })), 'id', JSON.stringify(id));
    }
  });

  it('内容は任意で、無ければ null。前後の空白は落とし、空なら null', () => {
    const { description: _omitted, ...withoutDescription } = valid;
    const omitted = parseCreateExpense(withoutDescription);
    assert.ok(omitted.ok);
    assert.equal(omitted.value.description, null);
    for (const [input, expected] of [
      ['  家賃  ', '家賃'],
      ['', null],
      ['   ', null],
      [null, null],
    ] as const) {
      const result = create({ description: input });
      assert.ok(result.ok);
      assert.equal(result.value.description, expected);
    }
  });

  it('内容は100文字まで（コードポイントで数える。絵文字も1文字）', () => {
    assert.ok(create({ description: 'あ'.repeat(100) }).ok);
    assert.equal(failedField(create({ description: 'あ'.repeat(101) })), 'description');
    assert.ok(create({ description: '🍎'.repeat(100) }).ok);
    assert.equal(failedField(create({ description: '🍎'.repeat(101) })), 'description');
    assert.equal(failedField(create({ description: 123 })), 'description');
  });

  it('金額は1〜10^12 の整数だけ', () => {
    assert.ok(create({ amountMinor: 1 }).ok);
    assert.ok(create({ amountMinor: 1_000_000_000_000 }).ok);
    for (const amountMinor of [0, -1, 1_000_000_000_001, 1.5, '4280', null, NaN, Infinity]) {
      assert.equal(failedField(create({ amountMinor })), 'amountMinor', String(amountMinor));
    }
  });

  it('日付は実在する日付、月は YYYY-MM', () => {
    assert.equal(failedField(create({ expenseDate: '2026-02-30' })), 'expenseDate');
    assert.equal(failedField(create({ expenseDate: '2026-11' })), 'expenseDate');
    assert.equal(failedField(create({ targetMonth: '2026-13' })), 'targetMonth');
    assert.equal(failedField(create({ targetMonth: '2026-11-01' })), 'targetMonth');
  });

  it('日付と登録する月は無関係に選べる（8章）', () => {
    assert.ok(create({ expenseDate: '2026-11-25', targetMonth: '2026-12' }).ok);
    assert.ok(create({ expenseDate: '2025-01-01', targetMonth: '2026-11' }).ok);
  });

  it('必須の項目が無ければ断る', () => {
    for (const key of ['expenseDate', 'targetMonth', 'amountMinor', 'categoryId', 'payerMemberId', 'split']) {
      const { [key]: _omitted, ...rest } = valid as Record<string, unknown>;
      assert.equal(failedField(parseCreateExpense(rest)), key);
    }
  });

  it('IDの形が違う・知らない項目は断る', () => {
    assert.equal(failedField(create({ categoryId: '' })), 'categoryId');
    assert.equal(failedField(create({ categoryId: 'a b' })), 'categoryId');
    assert.equal(failedField(create({ payerMemberId: 'x'.repeat(65) })), 'payerMemberId');
    assert.equal(failedField(create({ payerMemberID: 'member-1' })), 'payerMemberID');
    assert.equal(failedField(create({ expenseId: 'expense-1' })), 'expenseId');
  });
});

describe('負担の指定（split）', () => {
  const split = (value: unknown) => create({ split: value });

  it('category・single', () => {
    assert.ok(split({ method: 'category' }).ok);
    assert.ok(split({ method: 'single', memberId: 'member-2' }).ok);
    assert.equal(failedField(split({ method: 'category', memberIds: [] })), 'split.memberIds');
    assert.equal(failedField(split({ method: 'single' })), 'split.memberId');
  });

  it('equal: 対象メンバーは1人以上で、重複しない', () => {
    assert.ok(split({ method: 'equal', memberIds: ['a', 'b'] }).ok);
    assert.equal(failedField(split({ method: 'equal', memberIds: [] })), 'split.memberIds');
    assert.equal(failedField(split({ method: 'equal', memberIds: ['a', 'a'] })), 'split.memberIds');
    assert.equal(failedField(split({ method: 'equal', memberIds: 'a' })), 'split.memberIds');
    assert.equal(failedField(split({ method: 'equal' })), 'split.memberIds');
  });

  it('ratio: 割合の合計は10000。0%のメンバーも入れられる', () => {
    const ok = split({
      method: 'ratio',
      shares: [
        { memberId: 'a', basisPoints: 6000 },
        { memberId: 'b', basisPoints: 4000 },
        { memberId: 'c', basisPoints: 0 },
      ],
    });
    assert.ok(ok.ok);
    const sumNot10000 = split({
      method: 'ratio',
      shares: [
        { memberId: 'a', basisPoints: 6000 },
        { memberId: 'b', basisPoints: 3999 },
      ],
    });
    assert.equal(failedField(sumNot10000), 'split.shares');
    for (const bad of [
      [{ memberId: 'a', basisPoints: 10001 }],
      [{ memberId: 'a', basisPoints: -1 }, { memberId: 'b', basisPoints: 10001 }],
      [{ memberId: 'a', basisPoints: 33.3 }, { memberId: 'b', basisPoints: 9966.7 }],
      [{ memberId: 'a', basisPoints: 5000 }, { memberId: 'a', basisPoints: 5000 }],
      [{ memberId: 'a', basisPoints: 10000, extra: 1 }],
      [],
    ]) {
      assert.equal(failedField(split({ method: 'ratio', shares: bad })), 'split.shares');
    }
  });

  it('fixed: 金額は0以上の整数で、重複しない（合計の一致は金額を見て判定する）', () => {
    assert.ok(
      split({
        method: 'fixed',
        amounts: [
          { memberId: 'a', amountMinor: 3000 },
          { memberId: 'b', amountMinor: 0 },
        ],
      }).ok,
    );
    for (const bad of [
      [{ memberId: 'a', amountMinor: -1 }],
      [{ memberId: 'a', amountMinor: 1.5 }],
      [{ memberId: 'a', amountMinor: 1_000_000_000_001 }],
      [{ memberId: 'a', amountMinor: 1 }, { memberId: 'a', amountMinor: 2 }],
      [],
    ]) {
      assert.equal(failedField(split({ method: 'fixed', amounts: bad })), 'split.amounts');
    }
  });

  it('知らない方法・オブジェクトでないものは断る', () => {
    assert.equal(failedField(split({ method: 'percent' })), 'split.method');
    assert.equal(failedField(split('category')), 'split');
    assert.equal(failedField(split(null)), 'split');
    assert.equal(failedField(split([])), 'split');
  });
});

describe('支出の編集の入力', () => {
  it('送った項目だけを読む', () => {
    const result = parseUpdateExpense({ amountMinor: 5000 });
    assert.ok(result.ok);
    assert.deepEqual(result.value, { amountMinor: 5000 });
  });

  it('内容は null で消せる。送らなければ変えない', () => {
    const cleared = parseUpdateExpense({ description: null });
    assert.ok(cleared.ok);
    assert.equal(cleared.value.description, null);
    const untouched = parseUpdateExpense({ amountMinor: 1 });
    assert.ok(untouched.ok);
    assert.equal('description' in untouched.value, false);
  });

  it('空の本文・知らない項目・不正な値は断る', () => {
    assert.deepEqual(parseUpdateExpense({}), { ok: false, field: '' });
    assert.deepEqual(parseUpdateExpense({ foo: 1 }), { ok: false, field: 'foo' });
    // 編集で、支出のIDは変えられない（id は登録だけが受け取る）。
    assert.deepEqual(parseUpdateExpense({ id: 'expense-1' }), { ok: false, field: 'id' });
    assert.deepEqual(parseUpdateExpense({ amountMinor: 0 }), { ok: false, field: 'amountMinor' });
    assert.deepEqual(parseUpdateExpense({ targetMonth: '2026-13' }), { ok: false, field: 'targetMonth' });
    assert.deepEqual(parseUpdateExpense({ split: { method: 'nope' } }), { ok: false, field: 'split.method' });
  });

  it('負担の指定も、登録と同じ検査', () => {
    const result = parseUpdateExpense({ split: { method: 'equal', memberIds: ['a', 'b'] } });
    assert.ok(result.ok);
    assert.deepEqual(result.value.split, { method: 'equal', memberIds: ['a', 'b'] });
  });
});

describe('isId', () => {
  it('UUIDと、英数字・ハイフン・アンダースコアの64字まで', () => {
    assert.equal(isId('0b0b8f9e-7d5b-4f0e-8f4e-7c8a2b3d4e5f'), true);
    assert.equal(isId('member_1-a'), true);
    for (const value of ['', 'a/b', 'a b', '日本語', 'x'.repeat(65), null, 1]) {
      assert.equal(isId(value), false, String(value));
    }
  });
});
