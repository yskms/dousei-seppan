-- グループ・メンバー・招待。
--
-- 一度本番へ適用したマイグレーションは書き換えない。スキーマを変えるときは、次の番号の
-- ファイルを足す（`npm run migrations:create -- <名前>`）。
-- 設計と、各テーブルの意味は docs/backend-design.md（6章と付録A）。付録Aを変えたら、ここも揃える。
--
-- 方針（付録Aの冒頭）
-- - STRICT, WITHOUT ROWID。IDはTEXT（UUID）。時刻はUnixエポックのミリ秒。
-- - グループの配下のテーブルには、group_id（またはその親のID）が先頭の主キーか索引を持たせる。
--   無いと、グループの削除や親の行の削除（外部キーの確認）で、全グループの行を読む。

CREATE TABLE expense_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (name <> '' AND length(name) <= 30),
  currency_code TEXT NOT NULL CHECK (length(currency_code) = 3 AND currency_code = upper(currency_code)),
  currency_minor_unit INTEGER NOT NULL CHECK (currency_minor_unit BETWEEN 0 AND 3),
  timezone TEXT NOT NULL,
  data_version INTEGER NOT NULL DEFAULT 0 CHECK (data_version >= 0),
  write_token TEXT,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE group_members (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  -- アカウント削除時はWorkerが匿名化とあわせてNULLにする。SET NULLは消し漏れへの保険。
  user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  display_name TEXT NOT NULL CHECK (display_name <> '' AND length(display_name) <= 20),
  -- メンバーのアイコンの色。アプリ側の色の一覧のキー（例: 'pink'）。
  color TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'leaving', 'left', 'deleted')),
  history_from_month TEXT NOT NULL CHECK (history_from_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  leave_requested_month TEXT CHECK (leave_requested_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  expense_end_month TEXT CHECK (expense_end_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  CHECK (status <> 'deleted' OR user_id IS NULL),
  CHECK (status NOT IN ('leaving', 'left') OR expense_end_month IS NOT NULL),
  UNIQUE (id, group_id),
  UNIQUE (group_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_group_members_user ON group_members (user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  invited_by_member_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_member_id TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (invited_by_member_id, group_id) REFERENCES group_members (id, group_id),
  FOREIGN KEY (consumed_by_member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK ((consumed_at IS NULL) = (consumed_by_member_id IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_invites_group ON invites (group_id);
