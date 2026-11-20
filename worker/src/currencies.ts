// グループの通貨。コードと小数桁数の対応表（docs/backend-design.md 2章）。
//
// アプリの通貨の一覧と、この表を揃える（アプリとはコードを共有しない）。クライアントは通貨コードだけを送り、
// 小数桁数はこの表から決める（クライアントの申告を信じない。桁数を間違えると、金額が100倍・1/100になる）。
// 初期の一覧は JPY・USD・EUR・GBP・AUD・CAD・CNY・KRW。要望があれば足す。KWD（小数桁3）は、金額の計算の検査には使うが、
// 選べる通貨には入れていない。
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  JPY: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  CNY: 2,
  KRW: 0,
};

/** グループ作成時の通貨（2章）。 */
export const DEFAULT_CURRENCY_CODE = 'JPY';

/** 選べる通貨なら、その小数桁数。そうでなければ null。 */
export function minorUnitOf(currencyCode: string): number | null {
  return Object.hasOwn(CURRENCY_MINOR_UNITS, currencyCode) ? CURRENCY_MINOR_UNITS[currencyCode]! : null;
}
