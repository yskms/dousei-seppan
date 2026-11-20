// 入力の上限。DDLのCHECK（migrations/）と同じ値を、ここ1か所にまとめる（docs/backend-design.md 2章、付録A）。

/** 1件の金額の上限（通貨の最小単位）。JPYで1兆円。 */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

/** 支出・固定費の内容の最大文字数（Unicodeのコードポイント数。SQLite の length() と同じ数え方）。 */
export const MAX_DESCRIPTION_LENGTH = 100;

/** メンバーの表示名の最大文字数（Unicodeのコードポイント数。DDLの `group_members.display_name` のCHECKと同じ）。 */
export const MAX_DISPLAY_NAME_LENGTH = 20;

/** グループ名の最大文字数（コードポイント数。DDLの `expense_groups.name` のCHECKと同じ）。 */
export const MAX_GROUP_NAME_LENGTH = 30;

/** 費目の名前の最大文字数（コードポイント数。DDLの `categories.name` のCHECKと同じ）。 */
export const MAX_CATEGORY_NAME_LENGTH = 20;

/**
 * 1つのグループが持てる費目の数（アーカイブ済みを含む）。仮の値。月締めの書き込みは費目の数に応じて増える
 * （docs/backend-design.md 9章。費目30・メンバー6で、前の月の行を引き継ぐ月（よくある月）の月締めは実測47でFreeの上限（50）に
 * ぎりぎり収まるが、脱退の確定を含む月締めは65（締める月に行がある月でも53）で超える。公開前にPaidへ移す前提。
 * 上限やメンバー数を増やすときは、worker/test/closings.test.ts の「費目の上限(30)・メンバー6人」を測り直す）。
 */
export const MAX_CATEGORIES_PER_GROUP = 30;

/**
 * 1つのグループが持てる固定費の数（終了・停止したものを含む。テンプレートは物理削除しない）。仮の値。
 * 自動登録のCronは、グループごとに全テンプレートを読み、1回の書き込みにまとめる（docs/backend-design.md 7章）ので、
 * 上限は、その1回のD1のクエリ数がFreeの上限（50）に収まる大きさにする。
 */
export const MAX_RECURRING_EXPENSES_PER_GROUP = 50;
