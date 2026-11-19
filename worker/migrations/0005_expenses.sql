-- 支出と、個別設定の支出の負担額、固定費の作成記録。
--
-- 一度本番へ適用したマイグレーションは書き換えない。スキーマを変えるときは、次の番号の
-- ファイルを足す（`npm run migrations:create -- <名前>`）。
-- 設計と、各テーブルの意味は docs/backend-design.md（6章と付録A）。付録Aを変えたら、ここも揃える。
--
-- 方針（付録Aの冒頭）
-- - STRICT, WITHOUT ROWID。IDはTEXT（UUID）。時刻はUnixエポックのミリ秒。
-- - グループの配下のテーブルには、group_id（またはその親のID）が先頭の主キーか索引を持たせる。
--   無いと、グループの削除や親の行の削除（外部キーの確認）で、全グループの行を読む。

CREATE TABLE expenses (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  expense_date TEXT NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  description TEXT CHECK (description IS NULL OR length(description) <= 100),
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  category_id TEXT NOT NULL,
  payer_member_id TEXT NOT NULL,
  created_by_member_id TEXT NOT NULL,
  split_method TEXT NOT NULL CHECK (split_method IN ('category', 'equal', 'ratio', 'fixed', 'single')),
  recurring_expense_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (payer_member_id, group_id) REFERENCES group_members (id, group_id),
  FOREIGN KEY (created_by_member_id, group_id) REFERENCES group_members (id, group_id),
  -- recurring_expense_id がNULLなら、SQLiteは複合外部キーを検査しない。
  FOREIGN KEY (recurring_expense_id, group_id) REFERENCES recurring_expenses (id, group_id),
  -- target_month と expense_date の関係は制限しない（8章）。
  UNIQUE (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_expenses_group_month ON expenses (group_id, target_month, expense_date);

-- split_method が 'category' の支出には行を作らない（3章）。
CREATE TABLE expense_allocations (
  group_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  burden_minor INTEGER NOT NULL CHECK (burden_minor BETWEEN 0 AND 1000000000000),
  share_basis_points INTEGER CHECK (share_basis_points IS NULL OR share_basis_points BETWEEN 0 AND 10000),
  PRIMARY KEY (expense_id, member_id),
  FOREIGN KEY (expense_id, group_id) REFERENCES expenses (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_expense_allocations_group ON expense_allocations (group_id);

-- 固定費をどの月に作ったか。作った支出が消されても行は残し、作り直さない（7章）。
-- expense_id は、支出が消されうるため外部キーにしない。
CREATE TABLE recurring_expense_runs (
  group_id TEXT NOT NULL,
  recurring_expense_id TEXT NOT NULL,
  -- 予定の月。作った支出の target_month は、早めに締められていれば翌月以降になりうる（7章）。
  scheduled_month TEXT NOT NULL CHECK (scheduled_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  expense_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (recurring_expense_id, scheduled_month),
  FOREIGN KEY (recurring_expense_id, group_id) REFERENCES recurring_expenses (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_recurring_expense_runs_group ON recurring_expense_runs (group_id);
