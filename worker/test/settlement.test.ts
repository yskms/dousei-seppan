/// <reference types="node" />
// 負担額・精算額の計算（src/settlement.ts）。例は docs/plan.md と docs/backend-design.md のもの。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allocateByShares,
  allocateCategory,
  allocateEqually,
  computeMonth,
  matchTransfers,
  SettlementInputError,
  splitExpense,
  type MonthExpense,
} from '../src/settlement.ts';

const ME = 'm-a';
const PARTNER = 'm-b';
const THIRD = 'm-c';

const shares = (...pairs: [string, number][]) => pairs.map(([memberId, basisPoints]) => ({ memberId, basisPoints }));
const amounts = (result: { memberId: string; amount: number }[]) =>
  Object.fromEntries(result.map((item) => [item.memberId, item.amount]));
const categoryExpense = (categoryId: string, payerMemberId: string, amountMinor: number): MonthExpense => ({
  amountMinor,
  categoryId,
  payerMemberId,
  splitMethod: 'category',
});

describe('端数の配り方（2章）', () => {
  it('10,000円を3人で均等割り → 3,334円、3,333円、3,333円', () => {
    assert.deepEqual(amounts(allocateEqually(10000, [THIRD, ME, PARTNER])), { 'm-a': 3334, 'm-b': 3333, 'm-c': 3333 });
  });

  it('割合で分けた端数は、割合が0より大きいメンバーに固定順で1単位ずつ配る', () => {
    // 3人の均等（3334 / 3333 / 3333）で 100 円 → 33.34 / 33.33 / 33.33 → 切り捨て 33/33/33、残り1を先頭に。
    assert.deepEqual(amounts(allocateByShares(100, shares([ME, 3334], [PARTNER, 3333], [THIRD, 3333]))), {
      'm-a': 34,
      'm-b': 33,
      'm-c': 33,
    });
    // 先頭が0%なら、次の人に配る。
    assert.deepEqual(amounts(allocateByShares(1, shares([ME, 0], [PARTNER, 5000], [THIRD, 5000]))), {
      'm-a': 0,
      'm-b': 1,
      'm-c': 0,
    });
  });

  it('合計は、どんな金額・割合でも元の金額と一致する', () => {
    const rules = [
      shares([ME, 3334], [PARTNER, 3333], [THIRD, 3333]),
      shares([ME, 6500], [PARTNER, 3500]),
      shares([ME, 1], [PARTNER, 9999]),
      shares([ME, 0], [PARTNER, 10000]),
    ];
    for (const rule of rules) {
      for (const total of [0, 1, 2, 7, 99, 100, 101, 12345, 999999, 1_000_000_000_000]) {
        const sum = allocateByShares(total, rule).reduce((acc, item) => acc + item.amount, 0);
        assert.equal(sum, total);
      }
    }
  });

  it('1件の上限（10^12）に割合をかけても、精度が落ちない（BigIntで計算する）', () => {
    // 999,803,000,841 × 9239 は 2^53 を超える。Numberで計算すると、相手の切り捨ての値が
    // 923,717,992,477 になる（正しくは ...476。1円ずれる）。端数の1円は先頭（自分）に配る。
    assert.deepEqual(amounts(allocateByShares(999_803_000_841, shares([ME, 761], [PARTNER, 9239]))), {
      'm-a': 76_085_008_365,
      'm-b': 923_717_992_476,
    });
  });

  it('割合の合計が10000でないときは、投げる', () => {
    assert.throws(() => allocateByShares(100, shares([ME, 5000], [PARTNER, 4000])), SettlementInputError);
  });
});

describe('支出ごとの個別設定', () => {
  it('均等・割合・1人が全額', () => {
    assert.deepEqual(amounts(splitExpense(4281, { method: 'equal', memberIds: [ME, PARTNER] })), {
      'm-a': 2141,
      'm-b': 2140,
    });
    assert.deepEqual(amounts(splitExpense(1000, { method: 'ratio', shares: shares([ME, 7000], [PARTNER, 3000]) })), {
      'm-a': 700,
      'm-b': 300,
    });
    assert.deepEqual(amounts(splitExpense(1000, { method: 'single', memberId: PARTNER })), { 'm-b': 1000 });
  });

  it('金額指定は、合計が支出額と一致しないと投げる（差額を自動で配らない）', () => {
    const amountsOf = (a: number, b: number) => [
      { memberId: ME, amount: a },
      { memberId: PARTNER, amount: b },
    ];
    assert.deepEqual(amounts(splitExpense(1000, { method: 'fixed', amounts: amountsOf(600, 400) })), {
      'm-a': 600,
      'm-b': 400,
    });
    assert.throws(() => splitExpense(1000, { method: 'fixed', amounts: amountsOf(600, 300) }), SettlementInputError);
  });
});

describe('上限額つきの負担（3章）', () => {
  // 2人、外食の上限が自分の10,000円、超えた分の割合が自分0%・相手100%。
  const rule = { categoryId: 'eat-out', shares: shares([ME, 0], [PARTNER, 10000]), cap: { memberId: ME, capMinor: 10000 } };

  it('月合計が8,000円なら、自分が8,000円', () => {
    assert.deepEqual(amounts(allocateCategory(8000, rule)), { 'm-a': 8000, 'm-b': 0 });
  });

  it('月合計が15,000円なら、自分が10,000円、相手が5,000円', () => {
    assert.deepEqual(amounts(allocateCategory(15000, rule)), { 'm-a': 10000, 'm-b': 5000 });
  });

  it('超えた分の割合に、上限を負担する人を含められる', () => {
    const halves = { ...rule, shares: shares([ME, 5000], [PARTNER, 5000]) };
    assert.deepEqual(amounts(allocateCategory(15000, halves)), { 'm-a': 12500, 'm-b': 2500 });
  });

  it('上限を負担する人が割合に含まれていないと、投げる', () => {
    const broken = { ...rule, shares: shares([PARTNER, 10000]) };
    assert.throws(() => allocateCategory(15000, broken), SettlementInputError);
  });
});

describe('月の集計（3章）', () => {
  // 企画メモ5章「精算例」。
  const planExample = () =>
    computeMonth({
      memberIds: [ME, PARTNER],
      categories: [
        { categoryId: 'rent', shares: shares([ME, 6000], [PARTNER, 4000]) },
        { categoryId: 'food', shares: shares([ME, 5000], [PARTNER, 5000]) },
        { categoryId: 'daily', shares: shares([ME, 5000], [PARTNER, 5000]) },
        { categoryId: 'utility', shares: shares([ME, 6000], [PARTNER, 4000]) },
      ],
      expenses: [
        categoryExpense('rent', ME, 90000),
        categoryExpense('food', PARTNER, 30000),
        categoryExpense('daily', ME, 10000),
        categoryExpense('utility', PARTNER, 15000),
      ],
      carriedIn: [],
    });

  it('企画メモの精算例: 相手から自分へ17,000円', () => {
    const result = planExample();
    const me = result.members.find((m) => m.memberId === ME)!;
    const partner = result.members.find((m) => m.memberId === PARTNER)!;
    assert.equal(me.paidMinor, 100000);
    assert.equal(partner.paidMinor, 45000);
    assert.equal(me.burdenMinor, 83000);
    assert.equal(partner.burdenMinor, 62000);
    assert.deepEqual(result.transfers, [{ fromMemberId: PARTNER, toMemberId: ME, amountMinor: 17000 }]);
  });

  it('費目の割合は、1件ずつでなく月の合計にかける', () => {
    // 1円を3件、50:50。1件ずつ分けると端数が偏るが、月の合計3円を分けて 2 / 1 になる。
    const result = computeMonth({
      memberIds: [ME, PARTNER],
      categories: [{ categoryId: 'food', shares: shares([ME, 5000], [PARTNER, 5000]) }],
      expenses: [categoryExpense('food', ME, 1), categoryExpense('food', ME, 1), categoryExpense('food', ME, 1)],
      carriedIn: [],
    });
    assert.deepEqual(
      result.members.map((m) => m.burdenMinor),
      [2, 1],
    );
  });

  it('個別設定の支出は、費目の月合計（と上限）から外し、保存した負担額で数える', () => {
    const result = computeMonth({
      memberIds: [ME, PARTNER],
      categories: [
        { categoryId: 'eat-out', shares: shares([ME, 0], [PARTNER, 10000]), cap: { memberId: ME, capMinor: 10000 } },
      ],
      expenses: [
        categoryExpense('eat-out', ME, 8000),
        {
          amountMinor: 6000,
          categoryId: 'eat-out',
          payerMemberId: PARTNER,
          splitMethod: 'equal',
          allocations: [
            { memberId: ME, amount: 3000 },
            { memberId: PARTNER, amount: 3000 },
          ],
        },
      ],
      carriedIn: [],
    });
    // 上限は 8,000 だけにかかる（自分 8,000）。個別設定の 6,000 は 3,000 / 3,000。
    assert.deepEqual(
      result.members.map((m) => [m.memberId, m.burdenMinor]),
      [
        [ME, 11000],
        [PARTNER, 3000],
      ],
    );
    assert.deepEqual(result.categories, [
      {
        categoryId: 'eat-out',
        totalMinor: 14000,
        burdens: [
          { memberId: ME, amount: 11000 },
          { memberId: PARTNER, amount: 3000 },
        ],
      },
    ]);
  });

  it('費目ごとの負担額の合計は、その費目の合計と一致する', () => {
    for (const category of planExample().categories) {
      const sum = category.burdens.reduce((acc, item) => acc + item.amount, 0);
      assert.equal(sum, category.totalMinor);
    }
  });

  it('category の支出があるのに費目の設定が無いときは、投げる', () => {
    assert.throws(
      () =>
        computeMonth({ memberIds: [ME], categories: [], expenses: [categoryExpense('food', ME, 100)], carriedIn: [] }),
      SettlementInputError,
    );
  });
});

describe('繰越（4章）', () => {
  const twoPeopleFood = (payer: string, amount: number) => ({
    memberIds: [ME, PARTNER],
    categories: [{ categoryId: 'food', shares: shares([ME, 5000], [PARTNER, 5000]) }],
    expenses: [categoryExpense('food', payer, amount)],
  });

  it('繰越 5,000円 と、今月の差額 8,450円 を合算して 13,450円 の送金にする', () => {
    const result = computeMonth({
      ...twoPeopleFood(ME, 16900),
      carriedIn: [{ fromMemberId: PARTNER, toMemberId: ME, amountMinor: 5000 }],
    });
    const me = result.members.find((m) => m.memberId === ME)!;
    assert.equal(me.differenceMinor, 8450);
    assert.equal(me.carriedInMinor, 5000);
    assert.equal(me.netMinor, 13450);
    assert.deepEqual(result.transfers, [{ fromMemberId: PARTNER, toMemberId: ME, amountMinor: 13450 }]);
  });

  it('繰越は、支出の総額・負担額に入らない', () => {
    const result = computeMonth({
      ...twoPeopleFood(ME, 16900),
      carriedIn: [{ fromMemberId: PARTNER, toMemberId: ME, amountMinor: 5000 }],
    });
    assert.deepEqual(
      result.members.map((m) => [m.paidMinor, m.burdenMinor]),
      [
        [16900, 8450],
        [0, 8450],
      ],
    );
  });

  it('逆向きの繰越は、今月の差額と打ち消し合う', () => {
    const result = computeMonth({
      ...twoPeopleFood(ME, 16900),
      carriedIn: [{ fromMemberId: ME, toMemberId: PARTNER, amountMinor: 8450 }],
    });
    assert.deepEqual(result.transfers, []);
  });

  it('2か月続けて繰り越しても、二重に数えない（毎月、前の月の送金だけを足す）', () => {
    // 10月: 相手→自分 5,000 を繰越。11月: 支出なし、繰越 5,000 → 送金 5,000。これを繰越。
    // 12月: 今月の差額 1,000（相手→自分）と、11月の送金 5,000 だけを足す → 6,000（10月の分を足し直さない）。
    const november = computeMonth({
      memberIds: [ME, PARTNER],
      categories: [],
      expenses: [],
      carriedIn: [{ fromMemberId: PARTNER, toMemberId: ME, amountMinor: 5000 }],
    });
    assert.deepEqual(november.transfers, [{ fromMemberId: PARTNER, toMemberId: ME, amountMinor: 5000 }]);
    const december = computeMonth({ ...twoPeopleFood(ME, 2000), carriedIn: november.transfers });
    assert.deepEqual(december.transfers, [{ fromMemberId: PARTNER, toMemberId: ME, amountMinor: 6000 }]);
  });

  it('3人: 繰越の組み合わせが変わっても、各メンバーの精算する額と送金の合計は一致する', () => {
    // 自分→相手 の繰越 5,000 に、新しいメンバー C が加わった月。C は今月 10,000 を払い、4:3:3 で分ける。
    const result = computeMonth({
      memberIds: [ME, PARTNER, THIRD],
      categories: [{ categoryId: 'food', shares: shares([ME, 4000], [PARTNER, 3000], [THIRD, 3000]) }],
      expenses: [categoryExpense('food', THIRD, 10000)],
      carriedIn: [{ fromMemberId: ME, toMemberId: PARTNER, amountMinor: 5000 }],
    });
    for (const member of result.members) {
      const received = result.transfers.filter((t) => t.toMemberId === member.memberId);
      const sent = result.transfers.filter((t) => t.fromMemberId === member.memberId);
      const flow = received.reduce((a, t) => a + t.amountMinor, 0) - sent.reduce((a, t) => a + t.amountMinor, 0);
      assert.equal(flow, member.netMinor);
    }
    // 自分: 負担 -4,000 + 繰越 -5,000 → -9,000。相手: 負担 -3,000 + 繰越 +5,000 → +2,000。C: 10,000 - 3,000 → +7,000。
    assert.deepEqual(
      result.members.map((m) => m.netMinor),
      [-9000, 2000, 7000],
    );
    assert.deepEqual(result.transfers, [
      { fromMemberId: ME, toMemberId: PARTNER, amountMinor: 2000 },
      { fromMemberId: ME, toMemberId: THIRD, amountMinor: 7000 },
    ]);
  });
});

describe('送金の組み合わせ（3章）', () => {
  it('送金は最大で「精算する額が0でないメンバー数 - 1」件', () => {
    const members = [
      { memberId: 'm-1', netMinor: -300 },
      { memberId: 'm-2', netMinor: -200 },
      { memberId: 'm-3', netMinor: 100 },
      { memberId: 'm-4', netMinor: 400 },
      { memberId: 'm-5', netMinor: 0 },
    ];
    const transfers = matchTransfers(members);
    assert.ok(transfers.length <= 3);
    assert.deepEqual(transfers, [
      { fromMemberId: 'm-1', toMemberId: 'm-3', amountMinor: 100 },
      { fromMemberId: 'm-1', toMemberId: 'm-4', amountMinor: 200 },
      { fromMemberId: 'm-2', toMemberId: 'm-4', amountMinor: 200 },
    ]);
  });

  it('入力の並びに関係なく、同じ結果になる（固定のメンバー順）', () => {
    const members = [
      { memberId: 'm-3', netMinor: 100 },
      { memberId: 'm-1', netMinor: -300 },
      { memberId: 'm-4', netMinor: 400 },
      { memberId: 'm-2', netMinor: -200 },
    ];
    assert.deepEqual(matchTransfers(members), matchTransfers([...members].reverse()));
  });

  it('精算する額の合計が0でないときは、投げる', () => {
    assert.throws(() => matchTransfers([{ memberId: ME, netMinor: 1 }]), SettlementInputError);
  });
});
