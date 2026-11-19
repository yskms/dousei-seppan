/// <reference types="node" />
// セッションの認証（src/session.ts）の検査。Singfolio（worker/test/session.test.ts）の認証の部分に合わせた。
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  authenticateSession,
  isSessionToken,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
  sessionTokenFromRequest,
} from '../src/session.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';

const NOW = 1_800_000_000_000;

describe('セッションの認証', () => {
  let local: LocalDatabase;
  let db: D1Database;
  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
  });
  after(async () => {
    await local.dispose();
  });

  let counter = 0;
  const hashOf = (token: string) => createHash('sha256').update(token).digest('base64url');

  /** ユーザー・ログイン手段・セッションを作る。`lastUsedAt` はセッションの最後の利用。 */
  const newSession = async (lastUsedAt: number) => {
    const n = ++counter;
    const token = randomBytes(32).toString('base64url');
    await db.batch([
      db.prepare('INSERT INTO users (id, created_at, last_active_at) VALUES (?, ?, ?)').bind(`u${n}`, lastUsedAt, lastUsedAt),
      db
        .prepare(
          `INSERT INTO identities (id, user_id, provider, sub, created_at, last_sign_in_at)
           VALUES (?, ?, 'apple', ?, ?, ?)`,
        )
        .bind(`i${n}`, `u${n}`, `sub${n}`, lastUsedAt, lastUsedAt),
      db
        .prepare('INSERT INTO sessions (token_hash, identity_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
        .bind(hashOf(token), `i${n}`, lastUsedAt, lastUsedAt),
    ]);
    return { token, userId: `u${n}`, identityId: `i${n}`, sub: `sub${n}` };
  };
  const sessionRow = (token: string) =>
    db.prepare('SELECT last_used_at FROM sessions WHERE token_hash = ?').bind(hashOf(token)).first<{ last_used_at: number }>();
  const userActive = async (userId: string) =>
    (await db.prepare('SELECT last_active_at FROM users WHERE id = ?').bind(userId).first<{ last_active_at: number }>())!
      .last_active_at;

  it('有効なセッションから、ユーザーとログイン手段を引く', async () => {
    const s = await newSession(NOW);
    assert.deepEqual(await authenticateSession(db, s.token, NOW + 1000), {
      userId: s.userId,
      identityId: s.identityId,
      sub: s.sub,
      provider: 'apple',
    });
  });

  it('無い値・形が違う値は null（理由は区別しない）', async () => {
    assert.equal(await authenticateSession(db, randomBytes(32).toString('base64url'), NOW), null);
    assert.equal(await authenticateSession(db, 'short', NOW), null);
    assert.equal(await authenticateSession(db, '', NOW), null);
    assert.equal(await authenticateSession(db, `${'a'.repeat(42)}!`, NOW), null);
  });

  it('最後の利用から24時間たっていなければ、何も書かない', async () => {
    const s = await newSession(NOW);
    await authenticateSession(db, s.token, NOW + SESSION_TOUCH_INTERVAL_MS - 1);
    assert.equal((await sessionRow(s.token))!.last_used_at, NOW);
    assert.equal(await userActive(s.userId), NOW);
  });

  it('24時間以上たっていれば、セッションとアカウントの最後に使った時刻を進める', async () => {
    const s = await newSession(NOW);
    const later = NOW + SESSION_TOUCH_INTERVAL_MS;
    assert.notEqual(await authenticateSession(db, s.token, later), null);
    assert.equal((await sessionRow(s.token))!.last_used_at, later);
    assert.equal(await userActive(s.userId), later);
  });

  it('期限（90日）を過ぎたセッションは使えず、行も消える', async () => {
    // 認証に成功すると最後の利用の時刻が進む（24時間に1回）ので、境目の前後は別のセッションで見る。
    const justBefore = await newSession(NOW);
    assert.notEqual(await authenticateSession(db, justBefore.token, NOW + SESSION_TTL_MS - 1), null);
    const expired = await newSession(NOW);
    assert.equal(await authenticateSession(db, expired.token, NOW + SESSION_TTL_MS), null);
    assert.equal(await sessionRow(expired.token), null);
  });

  it('Authorization: Bearer から値を取り出す', () => {
    const token = randomBytes(32).toString('base64url');
    const request = (value?: string) => new Request('https://example.test/', { headers: value ? { authorization: value } : {} });
    assert.equal(isSessionToken(token), true);
    assert.equal(sessionTokenFromRequest(request(`Bearer ${token}`)), token);
    assert.equal(sessionTokenFromRequest(request(`bearer ${token}`)), token);
    assert.equal(sessionTokenFromRequest(request()), null);
    assert.equal(sessionTokenFromRequest(request(token)), null);
    assert.equal(sessionTokenFromRequest(request(`Basic ${token}`)), null);
    assert.equal(sessionTokenFromRequest(request('Bearer short')), null);
  });
});
