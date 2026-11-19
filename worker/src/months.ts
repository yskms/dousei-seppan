// 月と日付の扱い。月は `YYYY-MM`、日付は `YYYY-MM-DD` のTEXT（付録A）。月は文字列のまま大小を比べられる。
// 「今月」はグループのタイムゾーンで決める（docs/backend-design.md 4章・8章）。

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH_PATTERN.test(value);
}

/** 実在する日付か（2026-02-30 などは false）。 */
export function isDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // setUTCFullYear は、0〜99年を1900年代に読み替えない（Date.UTC は読み替える）。
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function nextMonth(month: string): string {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) throw new Error(`月の形式が違う: ${month}`);
  const year = Number(match[1]);
  const mon = Number(match[2]);
  return mon === 12 ? `${String(year + 1).padStart(4, '0')}-01` : `${match[1]}-${String(mon + 1).padStart(2, '0')}`;
}

export function maxMonth(a: string, b: string): string {
  return a >= b ? a : b;
}

/** `now`（Unixエポックのミリ秒）が属する月を、タイムゾーン（IANA名）で求める。 */
export function monthIn(timezone: string, now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(
    now,
  );
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (year === undefined || month === undefined) throw new Error(`月を求められない: ${timezone}`);
  return `${year.padStart(4, '0')}-${month}`;
}

/**
 * 支出を登録できる月の範囲（両端を含む。docs/backend-design.md 8章「支出の対象月」）。
 * 未締めの月のうち、カレンダー上の今月以前のもの。今月がすでに締められていれば、翌月だけ。
 *
 * - 下端: 最後に締めた月の翌月。まだ締めていなければ、グループを作った月（それより前の月に登録させると、
 *   「未締めの月は連続している」が崩れる）。月は古い順にしか締められないので、締め済みの月は連続している。
 * - 上端: 今月。ただし下端のほうが新しければ（今月を締めた後）、下端と同じ。
 */
export function registerableRange(input: {
  createdMonth: string;
  currentMonth: string;
  latestClosedMonth: string | null;
}): { from: string; to: string } {
  const from = input.latestClosedMonth === null ? input.createdMonth : nextMonth(input.latestClosedMonth);
  return { from, to: maxMonth(from, input.currentMonth) };
}
