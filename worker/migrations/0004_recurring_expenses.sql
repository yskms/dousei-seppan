-- 固定費のテンプレート。
--
-- 一度本番へ適用したマイグレーションは書き換えない。スキーマを変えるときは、次の番号の
-- ファイルを足す（`npm run migrations:create -- <名前>`）。
-- 設計と、各テーブルの意味は docs/backend-design.md（6章と付録A）。付録Aを変えたら、ここも揃える。
--
-- 方針（付録Aの冒頭）
-- - STRICT, WITHOUT ROWID。IDはTEXT（UUID）。時刻はUnixエポックのミリ秒。
-- - グループの配下のテーブルには、group_id（またはその親のID）が先頭の主キーか索引を持たせる。
--   無いと、グループの削除や親の行の削除（外部キーの確認）で、全グループの行を読む。

CREATE TABLE recurring_expenses (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  description TEXT CHECK (description IS NULL OR length(description) <= 100),
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  category_id TEXT NOT NULL,
  payer_member_id TEXT NOT NULL,
  split_method TEXT NOT NULL CHECK (split_method IN ('category', 'equal', 'ratio', 'fixed', 'single')),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  start_month TEXT NOT NULL CHECK (start_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  -- 終了した月。NULLなら終了日なし。テンプレートは物理削除しない。
  end_month TEXT CHECK (end_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  paused_at INTEGER,
  paused_reason TEXT CHECK (paused_reason IN ('member_changed', 'payer_left', 'manual')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (payer_member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK ((paused_at IS NULL) = (paused_reason IS NULL)),
  CHECK (end_month IS NULL OR end_month >= start_month),
  UNIQUE (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_recurring_expenses_group ON recurring_expenses (group_id);

-- split_method が 'category' 以外のときの個別負担設定。
-- equal・single は対象メンバーの行だけを持ち、割合・金額はNULL。
CREATE TABLE recurring_expense_allocations (
  group_id TEXT NOT NULL,
  recurring_expense_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  share_basis_points INTEGER,
  amount_minor INTEGER,
  PRIMARY KEY (recurring_expense_id, member_id),
  FOREIGN KEY (recurring_expense_id, group_id) REFERENCES recurring_expenses (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK (
    (share_basis_points IS NOT NULL AND amount_minor IS NULL AND share_basis_points BETWEEN 0 AND 10000)
    OR (share_basis_points IS NULL AND amount_minor IS NOT NULL AND amount_minor BETWEEN 0 AND 1000000000000)
    OR (share_basis_points IS NULL AND amount_minor IS NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_recurring_expense_allocations_group ON recurring_expense_allocations (group_id);
