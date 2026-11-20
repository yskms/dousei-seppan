// メンバーに関わるリクエストの本文の検査（参加）。形は docs/backend-design.md 9章「招待・参加・脱退」。
import { MAX_DISPLAY_NAME_LENGTH } from './limits.ts';
import type { ParseResult } from './expenseInput.ts';

export interface JoinInput {
  displayName: string;
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/**
 * 参加の本文: `{ "displayName": "…" }`。表示名は、前後の空白を落として、1〜20文字（コードポイント）。
 * 知らない項目は断る（打ち間違いを黙って捨てない）。
 */
export function parseJoin(body: Record<string, unknown>): ParseResult<JoinInput> {
  for (const key of Object.keys(body)) {
    if (key !== 'displayName') return { ok: false, field: key };
  }
  if (typeof body.displayName !== 'string') return { ok: false, field: 'displayName' };
  const displayName = body.displayName.trim();
  if (displayName === '' || codePointLength(displayName) > MAX_DISPLAY_NAME_LENGTH) {
    return { ok: false, field: 'displayName' };
  }
  return { ok: true, value: { displayName } };
}
