// 負担額・精算額の計算。DBに依存しない純粋な関数だけを置く（D1の読み書きは呼び出し側）。
// 仕様は docs/backend-design.md 2章（端数）・3章（負担・精算）・4章（繰越）。
//
// - 金額は通貨の最小単位の整数、割合は1万分率の整数（10000 = 100%）。浮動小数点で計算しない。
// - 割合をかける掛け算は BigInt で行う。1件の上限 10^12 に 10000 をかけると、2^53 を超えるため。
// - 「固定のメンバー順」は、メンバーIDの文字列の昇順（compareIds）。端末やリクエストの順に依存させない。
// - 入力の不整合（割合の合計が10000でない、知らないメンバー、など）は、黙って直さず SettlementInputError を投げる。
//   APIの検証で先に弾く前提で、ここに来たら実装の誤り。

export const BASIS_POINTS_TOTAL = 10000;

export class SettlementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementInputError';
  }
}

/** 固定のメンバー順（と、費目の並び）。IDの文字列の昇順。localeCompare は環境で変わりうるので使わない。 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface MemberShare {
  memberId: string;
  basisPoints: number;
}

export interface MemberAmount {
  memberId: string;
  amount: number;
}

function assertAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SettlementInputError(`${label} は0以上の安全な整数でなければならない: ${value}`);
  }
}

function assertUniqueMembers(memberIds: readonly string[], label: string): void {
  if (new Set(memberIds).size !== memberIds.length) {
    throw new SettlementInputError(`${label} に同じメンバーが重複している`);
  }
}

/**
 * total を割合で分ける（2章「端数」）。
 * 各メンバーを切り捨てで出し、残りを、割合が0より大きいメンバーに固定順で1単位ずつ配る。
 * 合計は必ず total と一致する。戻り値は固定のメンバー順。
 */
export function allocateByShares(total: number, shares: readonly MemberShare[]): MemberAmount[] {
  assertAmount(total, 'total');
  if (shares.length === 0) throw new SettlementInputError('割合が空');
  assertUniqueMembers(
    shares.map((share) => share.memberId),
    'shares',
  );
  let sum = 0;
  for (const share of shares) {
    if (!Number.isInteger(share.basisPoints) || share.basisPoints < 0 || share.basisPoints > BASIS_POINTS_TOTAL) {
      throw new SettlementInputError(`割合が範囲外: ${share.basisPoints}`);
    }
    sum += share.basisPoints;
  }
  if (sum !== BASIS_POINTS_TOTAL) throw new SettlementInputError(`割合の合計が10000でない: ${sum}`);

  const ordered = [...shares].sort((a, b) => compareIds(a.memberId, b.memberId));
  const bigTotal = BigInt(total);
  const result = ordered.map((share) => ({
    memberId: share.memberId,
    amount: Number((bigTotal * BigInt(share.basisPoints)) / BigInt(BASIS_POINTS_TOTAL)),
  }));
  let remainder = total - result.reduce((acc, item) => acc + item.amount, 0);
  // 残りは「割合が0より大きいメンバー数」より必ず小さいので、1周で配り終わる。
  for (let i = 0; remainder > 0; i = (i + 1) % ordered.length) {
    if (ordered[i]!.basisPoints > 0) {
      result[i]!.amount += 1;
      remainder -= 1;
    }
  }
  return result;
}

/** 対象メンバーで均等に分ける。端数は固定順で1単位ずつ。 */
export function allocateEqually(total: number, memberIds: readonly string[]): MemberAmount[] {
  assertAmount(total, 'total');
  if (memberIds.length === 0) throw new SettlementInputError('対象メンバーが空');
  assertUniqueMembers(memberIds, 'memberIds');
  const ordered = [...memberIds].sort(compareIds);
  const base = Math.floor(total / ordered.length);
  const remainder = total - base * ordered.length;
  return ordered.map((memberId, index) => ({ memberId, amount: base + (index < remainder ? 1 : 0) }));
}

// ---------------------------------------------------------------------------
// 支出ごとの個別設定（split_method が category 以外）。登録時に計算して expense_allocations に保存する。

export type ExpenseSplit =
  | { method: 'equal'; memberIds: readonly string[] }
  | { method: 'ratio'; shares: readonly MemberShare[] }
  | { method: 'fixed'; amounts: readonly MemberAmount[] }
  | { method: 'single'; memberId: string };

/** 個別設定の支出の、メンバーごとの負担額。合計は amount と一致する。 */
export function splitExpense(amount: number, split: ExpenseSplit): MemberAmount[] {
  assertAmount(amount, 'amount');
  switch (split.method) {
    case 'equal':
      return allocateEqually(amount, split.memberIds);
    case 'ratio':
      return allocateByShares(amount, split.shares);
    case 'single':
      return [{ memberId: split.memberId, amount }];
    case 'fixed': {
      // 差額の自動配分はしない（2章「金額指定」）。
      assertUniqueMembers(
        split.amounts.map((item) => item.memberId),
        'amounts',
      );
      let sum = 0;
      for (const item of split.amounts) {
        assertAmount(item.amount, 'fixed の金額');
        sum += item.amount;
      }
      if (sum !== amount) throw new SettlementInputError(`指定額の合計 ${sum} が支出額 ${amount} と一致しない`);
      return [...split.amounts].sort((a, b) => compareIds(a.memberId, b.memberId));
    }
  }
}

// ---------------------------------------------------------------------------
// 費目の負担（3章「上限額つきの負担」）。

export interface CategoryRule {
  categoryId: string;
  /** その月の割合（上限額つきなら、超えた分の割合）。 */
  shares: readonly MemberShare[];
  /** 上限額つきの負担。負担する人は shares に含まれていなければならない（割合は0%でよい）。 */
  cap?: { memberId: string; capMinor: number } | null;
}

/** 費目の月合計 categoryTotal（category の支出だけ）を、メンバーごとの負担額に分ける。 */
export function allocateCategory(categoryTotal: number, rule: CategoryRule): MemberAmount[] {
  assertAmount(categoryTotal, 'categoryTotal');
  const cap = rule.cap ?? null;
  if (cap === null) return allocateByShares(categoryTotal, rule.shares);

  if (!rule.shares.some((share) => share.memberId === cap.memberId)) {
    throw new SettlementInputError('上限額を負担する人が、その月の割合に含まれていない');
  }
  if (!Number.isSafeInteger(cap.capMinor) || cap.capMinor < 1) {
    throw new SettlementInputError(`上限額が範囲外: ${cap.capMinor}`);
  }
  const capped = Math.min(categoryTotal, cap.capMinor);
  const excess = allocateByShares(categoryTotal - capped, rule.shares);
  return excess.map((item) =>
    item.memberId === cap.memberId ? { memberId: item.memberId, amount: item.amount + capped } : item,
  );
}

// ---------------------------------------------------------------------------
// 月の集計と送金（3章「月次集計」「精算先の組み合わせ」、4章「繰越」）。

export type MonthExpense =
  | { amountMinor: number; categoryId: string; payerMemberId: string; splitMethod: 'category' }
  | {
      amountMinor: number;
      categoryId: string;
      payerMemberId: string;
      splitMethod: 'equal' | 'ratio' | 'fixed' | 'single';
      /** 登録時に保存した expense_allocations.burden_minor。 */
      allocations: readonly MemberAmount[];
    };

export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
}

export interface MonthInput {
  /** その月の集計に出すメンバー（負担対象、支払者、繰越の当事者をすべて含む）。 */
  memberIds: readonly string[];
  /** その月に使う費目の設定。category の支出がある費目は、必ず含める。 */
  categories: readonly CategoryRule[];
  expenses: readonly MonthExpense[];
  /** 前の月の締めで carried にした送金。 */
  carriedIn: readonly Transfer[];
}

export interface MemberSummary {
  memberId: string;
  paidMinor: number;
  burdenMinor: number;
  /** 支払額 - 負担額。 */
  differenceMinor: number;
  /** 繰越。送金先なら足し、送金元なら引く。 */
  carriedInMinor: number;
  /** 精算する額 = 差額 + 繰越。プラスは受取側、マイナスは支払側。 */
  netMinor: number;
}

export interface CategoryBurden {
  categoryId: string;
  /** その費目の支出の合計（個別設定の支出を含む）。 */
  totalMinor: number;
  /** 費目の割合による分と、個別設定の支出の分の合計。合計は totalMinor と一致する。 */
  burdens: MemberAmount[];
}

export interface MonthResult {
  /** 固定のメンバー順。 */
  members: MemberSummary[];
  /** 支出のある費目だけ。categoryId の昇順。 */
  categories: CategoryBurden[];
  transfers: Transfer[];
}

function addTo(map: Map<string, number>, key: string, amount: number): void {
  const next = (map.get(key) ?? 0) + amount;
  if (!Number.isSafeInteger(next)) throw new SettlementInputError('合計が安全な整数の範囲を超えた');
  map.set(key, next);
}

/**
 * 月の集計と、送金の組み合わせ。締めのときも、締める前の見込み（summary API）でも、同じ関数を使う。
 * 繰越は、支出の総額・負担額には入れず、精算する額にだけ入れる。
 */
export function computeMonth(input: MonthInput): MonthResult {
  const memberIds = [...input.memberIds].sort(compareIds);
  assertUniqueMembers(memberIds, 'memberIds');
  const known = new Set(memberIds);
  const requireMember = (memberId: string, label: string) => {
    if (!known.has(memberId)) throw new SettlementInputError(`${label} が集計のメンバーにいない: ${memberId}`);
  };

  const rules = new Map<string, CategoryRule>();
  for (const rule of input.categories) {
    if (rules.has(rule.categoryId)) throw new SettlementInputError(`費目の設定が重複: ${rule.categoryId}`);
    for (const share of rule.shares) requireMember(share.memberId, '費目の割合のメンバー');
    rules.set(rule.categoryId, rule);
  }

  const paid = new Map<string, number>();
  const burden = new Map<string, number>();
  const categoryTotals = new Map<string, number>(); // 個別設定を含む
  const categorySplitTotals = new Map<string, number>(); // category の支出だけ
  const categoryBurdens = new Map<string, Map<string, number>>();
  const burdensOf = (categoryId: string) => {
    let map = categoryBurdens.get(categoryId);
    if (!map) {
      map = new Map();
      categoryBurdens.set(categoryId, map);
    }
    return map;
  };

  for (const expense of input.expenses) {
    assertAmount(expense.amountMinor, 'amountMinor');
    if (expense.amountMinor === 0) throw new SettlementInputError('支出の金額が0');
    requireMember(expense.payerMemberId, '支払者');
    addTo(paid, expense.payerMemberId, expense.amountMinor);
    addTo(categoryTotals, expense.categoryId, expense.amountMinor);
    if (expense.splitMethod === 'category') {
      addTo(categorySplitTotals, expense.categoryId, expense.amountMinor);
      continue;
    }
    let sum = 0;
    for (const item of expense.allocations) {
      requireMember(item.memberId, '個別設定の負担者');
      assertAmount(item.amount, '個別設定の負担額');
      sum += item.amount;
      addTo(burden, item.memberId, item.amount);
      addTo(burdensOf(expense.categoryId), item.memberId, item.amount);
    }
    if (sum !== expense.amountMinor) {
      throw new SettlementInputError(`個別設定の負担額の合計 ${sum} が支出額 ${expense.amountMinor} と一致しない`);
    }
  }

  for (const [categoryId, total] of categorySplitTotals) {
    const rule = rules.get(categoryId);
    if (!rule) throw new SettlementInputError(`費目の設定が無い: ${categoryId}`);
    for (const item of allocateCategory(total, rule)) {
      addTo(burden, item.memberId, item.amount);
      addTo(burdensOf(categoryId), item.memberId, item.amount);
    }
  }

  const carried = new Map<string, number>();
  for (const transfer of input.carriedIn) {
    requireMember(transfer.fromMemberId, '繰越の送金元');
    requireMember(transfer.toMemberId, '繰越の送金先');
    assertAmount(transfer.amountMinor, '繰越の金額');
    addTo(carried, transfer.toMemberId, transfer.amountMinor);
    addTo(carried, transfer.fromMemberId, -transfer.amountMinor);
  }

  const members = memberIds.map((memberId): MemberSummary => {
    const paidMinor = paid.get(memberId) ?? 0;
    const burdenMinor = burden.get(memberId) ?? 0;
    const differenceMinor = paidMinor - burdenMinor;
    const carriedInMinor = carried.get(memberId) ?? 0;
    return {
      memberId,
      paidMinor,
      burdenMinor,
      differenceMinor,
      carriedInMinor,
      netMinor: differenceMinor + carriedInMinor,
    };
  });

  const categories = [...categoryTotals.keys()].sort(compareIds).map((categoryId) => ({
    categoryId,
    totalMinor: categoryTotals.get(categoryId)!,
    burdens: [...(categoryBurdens.get(categoryId) ?? new Map<string, number>())]
      .map(([memberId, amount]) => ({ memberId, amount }))
      .sort((a, b) => compareIds(a.memberId, b.memberId)),
  }));

  return { members, categories, transfers: matchTransfers(members) };
}

/**
 * 精算する額から、送金の組み合わせを作る（3章「精算先の組み合わせ」）。
 * 支払側と受取側をそれぞれ固定順で並べ、先頭同士から少ない方の残額を送金にする。
 * 送金は最大で「精算する額が0でないメンバー数 - 1」件。最少の件数までは保証しない。
 */
export function matchTransfers(members: readonly Pick<MemberSummary, 'memberId' | 'netMinor'>[]): Transfer[] {
  const ordered = [...members].sort((a, b) => compareIds(a.memberId, b.memberId));
  const total = ordered.reduce((acc, member) => acc + member.netMinor, 0);
  if (total !== 0) throw new SettlementInputError(`精算する額の合計が0でない: ${total}`);

  const payers = ordered.filter((m) => m.netMinor < 0).map((m) => ({ id: m.memberId, rest: -m.netMinor }));
  const receivers = ordered.filter((m) => m.netMinor > 0).map((m) => ({ id: m.memberId, rest: m.netMinor }));
  const transfers: Transfer[] = [];
  let p = 0;
  let r = 0;
  while (p < payers.length && r < receivers.length) {
    const payer = payers[p]!;
    const receiver = receivers[r]!;
    const amount = Math.min(payer.rest, receiver.rest);
    transfers.push({ fromMemberId: payer.id, toMemberId: receiver.id, amountMinor: amount });
    payer.rest -= amount;
    receiver.rest -= amount;
    if (payer.rest === 0) p += 1;
    if (receiver.rest === 0) r += 1;
  }
  return transfers;
}
