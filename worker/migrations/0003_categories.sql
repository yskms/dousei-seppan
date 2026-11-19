-- 費目と、月ごとの負担割合・上限額。
--
-- 一度本番へ適用したマイグレーションは書き換えない。スキーマを変えるときは、次の番号の
-- ファイルを足す（`npm run migrations:create -- <名前>`）。
-- 設計と、各テーブルの意味は docs/backend-design.md（6章と付録A）。付録Aを変えたら、ここも揃える。
--
-- 方針（付録Aの冒頭）
-- - STRICT, WITHOUT ROWID。IDはTEXT（UUID）。時刻はUnixエポックのミリ秒。
-- - グループの配下のテーブルには、group_id（またはその親のID）が先頭の主キーか索引を持たせる。
--   無いと、グループの削除や親の行の削除（外部キーの確認）で、全グループの行を読む。

CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  name TEXT NOT NULL CHECK (name <> '' AND length(name) <= 20),
  -- アプリ側のアイコン・色の一覧のキー（例: 'home', 'blue'）。知らないキーは、アプリが既定のアイコン・色で表示する。
  icon TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_categories_group ON categories (group_id);

-- 行が無い月は、その月以前で最も新しい月の行と、同じ月の category_month_shares の組を使う（3章）。
-- 上限額つきの負担を使わない月も、行は書く（どの月の設定を使うかを、この表の月で決めるため）。
CREATE TABLE category_month_settings (
  group_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  cap_member_id TEXT,
  cap_minor INTEGER CHECK (cap_minor BETWEEN 1 AND 1000000000000),
  PRIMARY KEY (category_id, target_month),
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (cap_member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK ((cap_member_id IS NULL) = (cap_minor IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_category_month_settings_group ON category_month_settings (group_id, target_month);

-- 超えた分の割合（上限額つきでなければ、月合計の割合）。category_month_settings と同じ月でまとめて書く。
CREATE TABLE category_month_shares (
  group_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  member_id TEXT NOT NULL,
  share_basis_points INTEGER NOT NULL CHECK (share_basis_points BETWEEN 0 AND 10000),
  PRIMARY KEY (category_id, target_month, member_id),
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_category_month_shares_group ON category_month_shares (group_id, target_month);
