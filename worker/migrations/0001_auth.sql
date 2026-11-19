-- 認証とアカウントのテーブル。Singfolio（~/Developer/singfolio）の worker/migrations/0001〜0003 の
-- 最終形を、1つにまとめてコピーした（コピー元: singfolio a87e3e0）。Singfolio側でスキーマを変えたら、
-- 必要な分を、次の番号のマイグレーションとして手で取り込む。
--
-- 一度本番へ適用したマイグレーションは書き換えない。スキーマを変えるときは、次の番号の
-- ファイルを足す（`npm run migrations:create -- <名前>`）。
--
-- 親テーブル（users・identities）は、DROP して作り直さない。外部キーの ON DELETE CASCADE が働き、
-- 子（identities・sessions）の行が消える（ローカルのD1では、PRAGMA でも止まらなかった。Singfolioの
-- worker/test/dropCascade.test.ts）。ALTER TABLE ... ADD COLUMN などで変える。
--
-- users を消すと、identities と sessions も CASCADE で消える。group_members.user_id は、Workerが
-- 先に匿名化して NULL にする（docs/backend-design.md 5章「アカウント削除」）。

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  -- 最後に使われた時刻。Singfolioと同じ列を持つ（認証のコードをそのままコピーするため）。
  last_active_at INTEGER
) STRICT, WITHOUT ROWID;

-- ログイン手段。`sub` はIDトークンの `sub`。email・名前などのクレームは保存しない。
CREATE TABLE identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google')),
  sub TEXT NOT NULL CHECK (sub <> ''),
  created_at INTEGER NOT NULL,
  -- 最後のサインインの時刻。Appleのサーバー間通知のうち、これより前の `event_time` のものを無視する。
  last_sign_in_at INTEGER NOT NULL,
  -- Appleの `consent-revoked` を処理した時刻。NULLは、取り消されたことが無い。
  consent_revoked_at INTEGER,
  UNIQUE (provider, sub)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_identities_user_id ON identities (user_id);

-- セッション。ランダム値のハッシュだけを置く（値そのものは端末のSecureStoreにだけある）。
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  identity_id TEXT NOT NULL REFERENCES identities (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_sessions_identity_id ON sessions (identity_id);

-- 使用済みの nonce。主キーの一意制約で、2回目を弾く。
CREATE TABLE used_nonces (
  nonce_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
