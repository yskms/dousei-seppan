// メンバーに関わるリクエストの本文の検査（参加・自分の名前と色の変更）。形は docs/backend-design.md 9章
// 「招待・参加・脱退」「グループ・メンバー」。
import { unknownKey, type ParseResult } from './expenseInput.ts';
import { MAX_DISPLAY_NAME_LENGTH } from './limits.ts';
import { MEMBER_COLORS } from './membership.ts';
import { parseLabel } from './textInput.ts';

export interface JoinInput {
  displayName: string;
}

/**
 * 参加の本文: `{ "displayName": "…" }`。表示名は、前後の空白を落として、1〜20文字（コードポイント）。
 * 知らない項目は断る（打ち間違いを黙って捨てない）。
 */
export function parseJoin(body: Record<string, unknown>): ParseResult<JoinInput> {
  for (const key of Object.keys(body)) {
    if (key !== 'displayName') return { ok: false, field: key };
  }
  const displayName = parseLabel(body.displayName, MAX_DISPLAY_NAME_LENGTH);
  if (displayName === null) return { ok: false, field: 'displayName' };
  return { ok: true, value: { displayName } };
}

/** 自分の名前と色の変更。送った項目だけを変える。 */
export interface UpdateMeInput {
  displayName?: string;
  color?: string;
}

/**
 * `{ "displayName"?: "…", "color"?: "pink" }`。1つ以上。色は、メンバーの色の一覧（`MEMBER_COLORS`）のキー。
 * 他のメンバーと同じ色も選べる（重ならない色を選ぶのは、参加のときだけ）。
 */
export function parseUpdateMe(body: Record<string, unknown>): ParseResult<UpdateMeInput> {
  const extra = unknownKey(body, ['displayName', 'color']);
  if (extra !== null) return { ok: false, field: extra };
  if (Object.keys(body).length === 0) return { ok: false, field: '' };
  const value: UpdateMeInput = {};
  if (body.displayName !== undefined) {
    const displayName = parseLabel(body.displayName, MAX_DISPLAY_NAME_LENGTH);
    if (displayName === null) return { ok: false, field: 'displayName' };
    value.displayName = displayName;
  }
  if (body.color !== undefined) {
    if (typeof body.color !== 'string' || !(MEMBER_COLORS as readonly string[]).includes(body.color)) {
      return { ok: false, field: 'color' };
    }
    value.color = body.color;
  }
  return { ok: true, value };
}
