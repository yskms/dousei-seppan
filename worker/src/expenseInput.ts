// 支出の登録・編集のリクエスト本文の検査。DBに依存しない（形と、本文だけで決まる値の検査まで）。
// リクエストの形は docs/backend-design.md 9章「支出API」。アプリとは、コードを共有せず、docsを正として両側に書く。
//
// - 知らない項目は、書き間違いを見逃さないよう、断る（400）。
// - 失敗は、直すべき項目の名前（`split.shares` など）を返す。値は返さない。
// - 金額の合計との一致（金額指定）と、メンバーがグループに居るか・その月に使えるかは、DBの状態が要るので
//   呼び出し側（src/expenses.ts）で見る。
import { MAX_AMOUNT_MINOR, MAX_DESCRIPTION_LENGTH } from './limits.ts';
import { isDate, isMonth } from './months.ts';
import { BASIS_POINTS_TOTAL, type MemberAmount, type MemberShare } from './settlement.ts';

export type SplitInput =
  | { method: 'category' }
  | { method: 'equal'; memberIds: string[] }
  | { method: 'ratio'; shares: MemberShare[] }
  | { method: 'fixed'; amounts: MemberAmount[] }
  | { method: 'single'; memberId: string };

export interface CreateExpenseInput {
  /**
   * アプリが作る、この登録の識別子（冪等キー）。通信が途切れて同じ登録を再送したときに、支出が2件できないように
   * する（docs/backend-design.md 9章の支出API「二重送信」）。UUID（小文字）だけを受け付ける。支出のIDは全グループで
   * 一意な主キーなので、短い値や連番を許すと、無関係なグループのIDがぶつかる。無ければ、Workerが決める（再送は防げない）。
   */
  id: string | null;
  expenseDate: string;
  targetMonth: string;
  description: string | null;
  amountMinor: number;
  categoryId: string;
  payerMemberId: string;
  split: SplitInput;
}

/** 編集。無い項目は変えない。`description` は null で消す。 */
export interface UpdateExpenseInput {
  expenseDate?: string;
  targetMonth?: string;
  description?: string | null;
  amountMinor?: number;
  categoryId?: string;
  payerMemberId?: string;
  split?: SplitInput;
}

/** 失敗は、直すべき項目の名前。本文全体の不備（空の本文）で項目を特定できないときは空文字。 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; field: string };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

// 小文字のUUID（`crypto.randomUUID()` の形）。大文字を許すと、同じUUIDが別のIDとして保存される。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

const fail = (field: string): { ok: false; field: string } => ({ ok: false, field });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 許す項目以外があれば、その名前を返す。 */
function unknownKey(record: Record<string, unknown>, allowed: readonly string[], prefix = ''): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return `${prefix}${key}`;
  }
  return null;
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/** 内容。前後の空白は落とし、空なら null。 */
function parseDescription(value: unknown): ParseResult<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return fail('description');
  const trimmed = value.trim();
  if (codePointLength(trimmed) > MAX_DESCRIPTION_LENGTH) return fail('description');
  return { ok: true, value: trimmed === '' ? null : trimmed };
}

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_AMOUNT_MINOR;

function parseSplit(value: unknown): ParseResult<SplitInput> {
  if (!isRecord(value)) return fail('split');
  switch (value.method) {
    case 'category': {
      const extra = unknownKey(value, ['method'], 'split.');
      return extra === null ? { ok: true, value: { method: 'category' } } : fail(extra);
    }
    case 'single': {
      const extra = unknownKey(value, ['method', 'memberId'], 'split.');
      if (extra !== null) return fail(extra);
      return isId(value.memberId) ? { ok: true, value: { method: 'single', memberId: value.memberId } } : fail('split.memberId');
    }
    case 'equal': {
      const extra = unknownKey(value, ['method', 'memberIds'], 'split.');
      if (extra !== null) return fail(extra);
      const ids = value.memberIds;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isId) || new Set(ids).size !== ids.length) {
        return fail('split.memberIds');
      }
      return { ok: true, value: { method: 'equal', memberIds: [...ids] } };
    }
    case 'ratio': {
      const extra = unknownKey(value, ['method', 'shares'], 'split.');
      if (extra !== null) return fail(extra);
      if (!Array.isArray(value.shares) || value.shares.length === 0) return fail('split.shares');
      const shares: MemberShare[] = [];
      for (const item of value.shares as unknown[]) {
        if (!isRecord(item) || unknownKey(item, ['memberId', 'basisPoints']) !== null) return fail('split.shares');
        const { memberId, basisPoints } = item;
        if (!isId(memberId) || typeof basisPoints !== 'number' || !Number.isInteger(basisPoints)) {
          return fail('split.shares');
        }
        if (basisPoints < 0 || basisPoints > BASIS_POINTS_TOTAL) return fail('split.shares');
        shares.push({ memberId, basisPoints });
      }
      if (new Set(shares.map((share) => share.memberId)).size !== shares.length) return fail('split.shares');
      // 割合の合計は10000（2章）。金額に依らないので、ここで見る。
      if (shares.reduce((sum, share) => sum + share.basisPoints, 0) !== BASIS_POINTS_TOTAL) return fail('split.shares');
      return { ok: true, value: { method: 'ratio', shares } };
    }
    case 'fixed': {
      const extra = unknownKey(value, ['method', 'amounts'], 'split.');
      if (extra !== null) return fail(extra);
      if (!Array.isArray(value.amounts) || value.amounts.length === 0) return fail('split.amounts');
      const amounts: MemberAmount[] = [];
      for (const item of value.amounts as unknown[]) {
        if (!isRecord(item) || unknownKey(item, ['memberId', 'amountMinor']) !== null) return fail('split.amounts');
        const { memberId, amountMinor } = item;
        if (!isId(memberId) || typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor)) {
          return fail('split.amounts');
        }
        if (amountMinor < 0 || amountMinor > MAX_AMOUNT_MINOR) return fail('split.amounts');
        amounts.push({ memberId, amount: amountMinor });
      }
      if (new Set(amounts.map((item) => item.memberId)).size !== amounts.length) return fail('split.amounts');
      return { ok: true, value: { method: 'fixed', amounts } };
    }
    default:
      return fail('split.method');
  }
}

const EXPENSE_KEYS = [
  'expenseDate',
  'targetMonth',
  'description',
  'amountMinor',
  'categoryId',
  'payerMemberId',
  'split',
] as const;

// 登録だけが `id` を受け取る。編集（PATCH）で支出のIDは変えられない。
const CREATE_EXPENSE_KEYS = ['id', ...EXPENSE_KEYS] as const;

export function parseCreateExpense(body: Record<string, unknown>): ParseResult<CreateExpenseInput> {
  const extra = unknownKey(body, CREATE_EXPENSE_KEYS);
  if (extra !== null) return fail(extra);
  if (body.id !== undefined && !isUuid(body.id)) return fail('id');
  if (!isDate(body.expenseDate)) return fail('expenseDate');
  if (!isMonth(body.targetMonth)) return fail('targetMonth');
  const description = parseDescription(body.description === undefined ? null : body.description);
  if (!description.ok) return description;
  if (!isAmount(body.amountMinor)) return fail('amountMinor');
  if (!isId(body.categoryId)) return fail('categoryId');
  if (!isId(body.payerMemberId)) return fail('payerMemberId');
  const split = parseSplit(body.split);
  if (!split.ok) return split;
  return {
    ok: true,
    value: {
      id: body.id === undefined ? null : body.id,
      expenseDate: body.expenseDate,
      targetMonth: body.targetMonth,
      description: description.value,
      amountMinor: body.amountMinor,
      categoryId: body.categoryId,
      payerMemberId: body.payerMemberId,
      split: split.value,
    },
  };
}

export function parseUpdateExpense(body: Record<string, unknown>): ParseResult<UpdateExpenseInput> {
  const extra = unknownKey(body, EXPENSE_KEYS);
  if (extra !== null) return fail(extra);
  if (Object.keys(body).length === 0) return fail('');
  const value: UpdateExpenseInput = {};
  if (body.expenseDate !== undefined) {
    if (!isDate(body.expenseDate)) return fail('expenseDate');
    value.expenseDate = body.expenseDate;
  }
  if (body.targetMonth !== undefined) {
    if (!isMonth(body.targetMonth)) return fail('targetMonth');
    value.targetMonth = body.targetMonth;
  }
  if (body.description !== undefined) {
    const description = parseDescription(body.description);
    if (!description.ok) return description;
    value.description = description.value;
  }
  if (body.amountMinor !== undefined) {
    if (!isAmount(body.amountMinor)) return fail('amountMinor');
    value.amountMinor = body.amountMinor;
  }
  if (body.categoryId !== undefined) {
    if (!isId(body.categoryId)) return fail('categoryId');
    value.categoryId = body.categoryId;
  }
  if (body.payerMemberId !== undefined) {
    if (!isId(body.payerMemberId)) return fail('payerMemberId');
    value.payerMemberId = body.payerMemberId;
  }
  if (body.split !== undefined) {
    const split = parseSplit(body.split);
    if (!split.ok) return split;
    value.split = split.value;
  }
  return { ok: true, value };
}
