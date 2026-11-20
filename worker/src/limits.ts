// 入力の上限。DDLのCHECK（migrations/）と同じ値を、ここ1か所にまとめる（docs/backend-design.md 2章、付録A）。

/** 1件の金額の上限（通貨の最小単位）。JPYで1兆円。 */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

/** 支出・固定費の内容の最大文字数（Unicodeのコードポイント数。SQLite の length() と同じ数え方）。 */
export const MAX_DESCRIPTION_LENGTH = 100;

/** メンバーの表示名の最大文字数（Unicodeのコードポイント数。DDLの `group_members.display_name` のCHECKと同じ）。 */
export const MAX_DISPLAY_NAME_LENGTH = 20;
