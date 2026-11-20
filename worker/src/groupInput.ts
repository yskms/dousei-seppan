// グループの作成・変更のリクエスト本文の検査。DBに依存しない。形は docs/backend-design.md 9章
// 「グループ・メンバー・招待」。アプリとは、コードを共有せず、docsを正として両側に書く。
//
// - 知らない項目は、書き間違いを見逃さないよう、断る（400）。
// - 失敗は、直すべき項目の名前を返す。値は返さない。
import { isUuid, unknownKey, type ParseResult } from './expenseInput.ts';
import { DEFAULT_CURRENCY_CODE, minorUnitOf } from './currencies.ts';
import { MAX_DISPLAY_NAME_LENGTH, MAX_GROUP_NAME_LENGTH } from './limits.ts';
import { parseLabel } from './textInput.ts';

export interface CreateGroupInput {
  /** アプリが作る、この作成の識別子（冪等キー）。UUID（小文字）。無ければ Worker が決める（再送は防げない）。 */
  id: string | null;
  name: string;
  /** 作った人の、このグループでの表示名。 */
  displayName: string;
  currencyCode: string;
  /** IANAのタイムゾーン名。月の境目（今月）を決める（4章・8章）。 */
  timezone: string;
}

export interface UpdateGroupInput {
  name?: string;
  currencyCode?: string;
}

const fail = (field: string): { ok: false; field: string } => ({ ok: false, field });

const TIMEZONE_PATTERN = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * 使えるタイムゾーン名か（`Asia/Tokyo` など）。形を絞ったうえで、実行環境が知っている名前だけを通す。
 * `+09:00` のようなオフセット指定は通さない（夏時間や、国の都合の切り替わりを持てない）。
 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !TIMEZONE_PATTERN.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** 通貨コード（ISO 4217の3文字・大文字）で、選べる通貨か。 */
function isSelectableCurrency(value: unknown): value is string {
  return typeof value === 'string' && minorUnitOf(value) !== null;
}

/**
 * 作成の本文: `{ id?, name, displayName, currencyCode?, timezone }`。通貨の初期値は日本円（2章）。
 * 名前は1〜30文字、表示名は1〜20文字（どちらも前後の空白を落とす。コードポイントで数える）。
 */
export function parseCreateGroup(body: Record<string, unknown>): ParseResult<CreateGroupInput> {
  const extra = unknownKey(body, ['id', 'name', 'displayName', 'currencyCode', 'timezone']);
  if (extra !== null) return fail(extra);
  if (body.id !== undefined && !isUuid(body.id)) return fail('id');
  const name = parseLabel(body.name, MAX_GROUP_NAME_LENGTH);
  if (name === null) return fail('name');
  const displayName = parseLabel(body.displayName, MAX_DISPLAY_NAME_LENGTH);
  if (displayName === null) return fail('displayName');
  const currencyCode = body.currencyCode === undefined ? DEFAULT_CURRENCY_CODE : body.currencyCode;
  if (!isSelectableCurrency(currencyCode)) return fail('currencyCode');
  if (!isTimeZone(body.timezone)) return fail('timezone');
  return {
    ok: true,
    value: { id: body.id === undefined ? null : body.id, name, displayName, currencyCode, timezone: body.timezone },
  };
}

/** 変更の本文: `{ name?, currencyCode? }`。送った項目だけを変える（1つ以上）。 */
export function parseUpdateGroup(body: Record<string, unknown>): ParseResult<UpdateGroupInput> {
  const extra = unknownKey(body, ['name', 'currencyCode']);
  if (extra !== null) return fail(extra);
  if (Object.keys(body).length === 0) return fail('');
  const value: UpdateGroupInput = {};
  if (body.name !== undefined) {
    const name = parseLabel(body.name, MAX_GROUP_NAME_LENGTH);
    if (name === null) return fail('name');
    value.name = name;
  }
  if (body.currencyCode !== undefined) {
    if (!isSelectableCurrency(body.currencyCode)) return fail('currencyCode');
    value.currencyCode = body.currencyCode;
  }
  return { ok: true, value };
}
