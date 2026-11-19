-- 月締めの結果と送金。
--
-- 一度本番へ適用したマイグレーションは書き換えない。スキーマを変えるときは、次の番号の
-- ファイルを足す（`npm run migrations:create -- <名前>`）。
-- 設計と、各テーブルの意味は docs/backend-design.md（6章と付録A）。付録Aを変えたら、ここも揃える。
--
-- 方針（付録Aの冒頭）
-- - STRICT, WITHOUT ROWID。IDはTEXT（UUID）。時刻はUnixエポックのミリ秒。
-- - グループの配下のテーブルには、group_id（またはその親のID）が先頭の主キーか索引を持たせる。
--   無いと、グループの削除や親の行の削除（外部キーの確認）で、全グループの行を読む。

CREATE TABLE monthly_closings (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  currency_code TEXT NOT NULL,
  currency_minor_unit INTEGER NOT NULL CHECK (currency_minor_unit BETWEEN 0 AND 3),
  data_version INTEGER NOT NULL,
  closed_by_member_id TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  FOREIGN KEY (closed_by_member_id, group_id) REFERENCES group_members (id, group_id),
  UNIQUE (id, group_id),
  UNIQUE (group_id, target_month)
) STRICT, WITHOUT ROWID;

CREATE TABLE closing_member_summaries (
  group_id TEXT NOT NULL,
  closing_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  paid_minor INTEGER NOT NULL CHECK (paid_minor >= 0),
  burden_minor INTEGER NOT NULL CHECK (burden_minor >= 0),
  difference_minor INTEGER NOT NULL,
  carried_in_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL,
  PRIMARY KEY (closing_id, member_id),
  FOREIGN KEY (closing_id, group_id) REFERENCES monthly_closings (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK (difference_minor = paid_minor - burden_minor),
  CHECK (net_minor = difference_minor + carried_in_minor)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_closing_member_summaries_group ON closing_member_summaries (group_id);

-- total_minor は、その費目の支出の合計（個別設定の支出を含む）。
-- burden_minor は、その費目でのそのメンバーの負担額（費目の割合による分と、個別設定の支出の分の合計）。
-- 費目ごとに、全メンバーの burden_minor の合計は total_minor と一致する。
CREATE TABLE closing_category_burdens (
  group_id TEXT NOT NULL,
  closing_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  burden_minor INTEGER NOT NULL CHECK (burden_minor >= 0),
  PRIMARY KEY (closing_id, category_id, member_id),
  FOREIGN KEY (closing_id, group_id) REFERENCES monthly_closings (id, group_id),
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_closing_category_burdens_group ON closing_category_burdens (group_id);

CREATE TABLE settlement_transfers (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  closing_id TEXT NOT NULL,
  from_member_id TEXT NOT NULL,
  to_member_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'carried')),
  settled_at INTEGER,
  carried_at INTEGER,
  processed_by_member_id TEXT,
  FOREIGN KEY (closing_id, group_id) REFERENCES monthly_closings (id, group_id),
  FOREIGN KEY (from_member_id, group_id) REFERENCES group_members (id, group_id),
  FOREIGN KEY (to_member_id, group_id) REFERENCES group_members (id, group_id),
  FOREIGN KEY (processed_by_member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK (from_member_id <> to_member_id),
  CHECK (
    (status = 'pending' AND settled_at IS NULL AND carried_at IS NULL AND processed_by_member_id IS NULL)
    OR (status = 'settled' AND settled_at IS NOT NULL AND carried_at IS NULL AND processed_by_member_id IS NOT NULL)
    OR (status = 'carried' AND carried_at IS NOT NULL AND settled_at IS NULL AND processed_by_member_id IS NOT NULL)
  ),
  UNIQUE (closing_id, from_member_id, to_member_id)
) STRICT, WITHOUT ROWID;

-- 翌月の締めで、前の月の締めの carried の送金を読むときにも使う。
CREATE INDEX idx_settlement_transfers_group ON settlement_transfers (group_id, closing_id);
