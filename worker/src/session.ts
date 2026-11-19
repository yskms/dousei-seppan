// セッションの認証。Singfolio（worker/src/session.ts）の `authenticateSession` と、それが使うものだけの
// コピー（コピー元: singfolio 61e0a82）。セッションの発行・失効（createSession・revokeSession・
// revokeOtherSessions）は、ログイン・ログアウトのAPIと一緒に、あとで同じ元から取り込む。
// Singfolio側を直したときは、差分を手で取り込む（docs/backend-design.md 1章）。
//
// セッションの値は、不透明なランダム値（32バイト = base64url の43字。JWTにしない）。D1の `sessions` には
// ハッシュ（SHA-256 の base64url）だけを置き、値そのものは端末のSecureStoreにだけある。値は
// `Authorization: Bearer <値>` で送る（URLに載せない）。ログにも出さない。

// 期限は、最後の利用から90日（目安）。最後の利用の時刻（`last_used_at`）は、前回の書き込みから24時間以上
// たったときだけ書くので、期限は実際の最後の利用から、最大24時間早まる。
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// 毎回書くと、D1のFreeの書き込みの上限（10万行/日）を、認証済みのリクエストの数だけ消費する。
export const SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BEARER_PATTERN = /^bearer ([A-Za-z0-9_-]{43})$/i;

export type IdTokenProvider = 'apple' | 'google';

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

// 値は256ビットの乱数なので、ソルトの無い SHA-256 でよい（総当たりで引ける短い値ではない）。
export async function hashToken(token: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}

/** `Authorization: Bearer <値>` から、セッションの値を取り出す。無い・形が違うなら null。 */
export function sessionTokenFromRequest(request: Request): string | null {
  return BEARER_PATTERN.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
}

/**
 * アカウントの最後に使った時刻を進める文。時計が戻る値は書かない。NULL は埋める。
 * 書き込みを増やしすぎないよう、呼び出し側が、すでに書く操作（24時間に1回のセッションの更新など）に付ける。
 */
export function markUserActiveStatement(db: D1Database, userId: string, now: number): D1PreparedStatement {
  return db
    .prepare('UPDATE users SET last_active_at = ?1 WHERE id = ?2 AND (last_active_at IS NULL OR last_active_at < ?1)')
    .bind(now, userId);
}

export interface AuthenticatedSession {
  userId: string;
  identityId: string;
  /** このセッションを作ったログイン手段の `sub`（アカウントの削除の再認証で、同じアカウントか確かめる）。 */
  sub: string;
  /** このセッションを作ったログイン手段。 */
  provider: IdTokenProvider;
}

/**
 * セッションの値から、ユーザーを引く。無い・期限切れ・形が違うなら null（理由は区別しない）。
 * ユーザーIDは、クライアントから受け取らず、ここで得たものだけを使う。
 * 通ったとき、`last_used_at` が24時間以上前なら、更新する（それより新しければ書かない）。
 * 期限を過ぎた行は、見つかった時点で消す。
 */
export async function authenticateSession(
  db: D1Database,
  token: string,
  now: number,
): Promise<AuthenticatedSession | null> {
  if (!isSessionToken(token)) return null;
  const hash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT s.last_used_at AS last_used_at, s.identity_id AS identity_id, i.user_id AS user_id, i.provider AS provider, i.sub AS sub
       FROM sessions s JOIN identities i ON i.id = s.identity_id
       WHERE s.token_hash = ?1`,
    )
    .bind(hash)
    .first<{ last_used_at: number; identity_id: string; user_id: string; provider: IdTokenProvider; sub: string }>();
  if (row === null) return null;

  const idle = now - row.last_used_at;
  if (idle >= SESSION_TTL_MS) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(hash).run();
    return null;
  }
  if (idle >= SESSION_TOUCH_INTERVAL_MS) {
    // 同時の2つのリクエストが両方書いても、同じ値になる。時計が戻る値は書かない。
    // アカウントの最後に使った時刻（未使用のアカウントの自動削除の基準）も、セッションと同じ頻度（24時間に1回）で進める。
    await db.batch([
      db.prepare('UPDATE sessions SET last_used_at = ?1 WHERE token_hash = ?2 AND last_used_at < ?1').bind(now, hash),
      markUserActiveStatement(db, row.user_id, now),
    ]);
  }
  return { userId: row.user_id, identityId: row.identity_id, sub: row.sub, provider: row.provider };
}
