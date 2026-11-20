// 固定費の登録・変更のリクエスト本文の検査。DBに依存しない（形と、本文だけで決まる値の検査まで）。
// リクエストの形は docs/backend-design.md 9章「固定費API」。アプリとは、コードを共有せず、docsを正として両側に書く。
// 負担の指定（`split`）・内容・金額・通貨コードの形は、支出の登録と同じ（expenseInput.ts）。
//
// - 知らない項目は、書き間違いを見逃さないよう、断る（400）。
// - 失敗は、直すべき項目の名前を返す。値は返さない。
// - 金額指定の合計と金額の一致（金額を変えるとき）、メンバーがグループに居るか・使えるか、終了月と開始月の前後
//   （片方しか送られないとき）は、DBの状態が要るので呼び出し側（src/recurring.ts）で見る。
import {
  isCurrencyCodeShape,
  isAmount,
  isId,
  isUuid,
  parseDescription,
  parseSplit,
  unknownKey,
  type ParseResult,
  type SplitInput,
} from './expenseInput.ts';
import { isMonth } from './months.ts';

export interface CreateRecurringInput {
  /**
   * アプリが作る、この登録の識別子(冪等キー)。通信が途切れて同じ登録を再送したときに、固定費が2件できて、毎月2件ずつ
   * 支出が作られるのを防ぐ。UUID(小文字)だけを受け付ける。無ければ、Workerが決める(再送は防げない)。
   */
  id: string | null;
  description: string | null;
  amountMinor: number;
  categoryId: string;
  payerMemberId: string;
  split: SplitInput;
  /** 毎月の登録日(1〜31)。その月に無い日は月末日(7章)。 */
  dayOfMonth: number;
  /** この月から作る(グループの今月より前でもよい。作るのは、今月の分から)。 */
  startMonth: string;
  /** この月まで作る。無ければ終了なし。 */
  endMonth: string | null;
  /** 金額を入力したときの通貨(支出の登録と同じ。2章)。無ければ検査しない。 */
  currencyCode: string | null;
}

/** 変更。無い項目は変えない。`description`・`endMonth` は null で消す。 */
export interface UpdateRecurringInput {
  description?: string | null;
  amountMinor?: number;
  categoryId?: string;
  payerMemberId?: string;
  split?: SplitInput;
  dayOfMonth?: number;
  startMonth?: string;
  endMonth?: string | null;
  /** true で止める(`manual`)。false で再開する。 */
  paused?: boolean;
  currencyCode?: string;
}

const fail = (field: string): { ok: false; field: string } => ({ ok: false, field });

const isDayOfMonth = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31;

const FIELD_KEYS = [
  'description',
  'amountMinor',
  'categoryId',
  'payerMemberId',
  'split',
  'dayOfMonth',
  'startMonth',
  'endMonth',
  'currencyCode',
] as const;

// 登録だけが `id` を受け取る。変更(PATCH)で固定費のIDは変えられない。止める・再開するは、変更だけ。
const CREATE_KEYS = ['id', ...FIELD_KEYS] as const;
const UPDATE_KEYS = [...FIELD_KEYS, 'paused'] as const;

export function parseCreateRecurring(body: Record<string, unknown>): ParseResult<CreateRecurringInput> {
  const extra = unknownKey(body, CREATE_KEYS);
  if (extra !== null) return fail(extra);
  if (body.id !== undefined && !isUuid(body.id)) return fail('id');
  const description = parseDescription(body.description === undefined ? null : body.description);
  if (!description.ok) return description;
  if (!isAmount(body.amountMinor)) return fail('amountMinor');
  if (!isId(body.categoryId)) return fail('categoryId');
  if (!isId(body.payerMemberId)) return fail('payerMemberId');
  const split = parseSplit(body.split);
  if (!split.ok) return split;
  if (!isDayOfMonth(body.dayOfMonth)) return fail('dayOfMonth');
  if (!isMonth(body.startMonth)) return fail('startMonth');
  const endMonth = body.endMonth === undefined ? null : body.endMonth;
  if (endMonth !== null && !isMonth(endMonth)) return fail('endMonth');
  if (endMonth !== null && endMonth < body.startMonth) return fail('endMonth');
  if (body.currencyCode !== undefined && !isCurrencyCodeShape(body.currencyCode)) return fail('currencyCode');
  return {
    ok: true,
    value: {
      id: body.id === undefined ? null : body.id,
      description: description.value,
      amountMinor: body.amountMinor,
      categoryId: body.categoryId,
      payerMemberId: body.payerMemberId,
      split: split.value,
      dayOfMonth: body.dayOfMonth,
      startMonth: body.startMonth,
      endMonth,
      currencyCode: body.currencyCode === undefined ? null : body.currencyCode,
    },
  };
}

export function parseUpdateRecurring(body: Record<string, unknown>): ParseResult<UpdateRecurringInput> {
  const extra = unknownKey(body, UPDATE_KEYS);
  if (extra !== null) return fail(extra);
  if (Object.keys(body).length === 0) return fail('');
  const value: UpdateRecurringInput = {};
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
  if (body.dayOfMonth !== undefined) {
    if (!isDayOfMonth(body.dayOfMonth)) return fail('dayOfMonth');
    value.dayOfMonth = body.dayOfMonth;
  }
  if (body.startMonth !== undefined) {
    if (!isMonth(body.startMonth)) return fail('startMonth');
    value.startMonth = body.startMonth;
  }
  if (body.endMonth !== undefined) {
    if (body.endMonth !== null && !isMonth(body.endMonth)) return fail('endMonth');
    value.endMonth = body.endMonth;
  }
  // 両方送られたときは、ここで前後を見る。片方だけのときは、保存してある相手と比べる(呼び出し側)。
  if (value.startMonth !== undefined && value.endMonth != null && value.endMonth < value.startMonth) {
    return fail('endMonth');
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== 'boolean') return fail('paused');
    value.paused = body.paused;
  }
  if (body.currencyCode !== undefined) {
    if (!isCurrencyCodeShape(body.currencyCode)) return fail('currencyCode');
    value.currencyCode = body.currencyCode;
  }
  return { ok: true, value };
}
