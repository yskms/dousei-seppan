// 名前などの短い文字列の検査（グループ名・表示名・費目の名前）。DBに依存しない。
import { codePointLength } from './expenseInput.ts';

// 制御文字（改行・タブ・NULを含む）。名前に入ると、表示が崩れる。SQLite の length() は NUL で数えが止まる。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * 前後の空白を落として、1文字以上、`maxLength` 文字（コードポイント）以下で、制御文字を含まない文字列。
 * 満たさなければ null。上限は、DDLの CHECK（`length()`）と同じ数え方。
 */
export function parseLabel(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || codePointLength(trimmed) > maxLength) return null;
  if (CONTROL_CHARACTERS.test(trimmed)) return null;
  return trimmed;
}
