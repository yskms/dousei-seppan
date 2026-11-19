/// <reference types="node" />
// 「読み直して1回だけやり直す」書き込み（src/groupWrite.ts の writeToGroupWithRetry）の検査。docs/backend-design.md 8章。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GROUP_WRITE_GUARD, readDataVersion, writeToGroupWithRetry } from '../src/groupWrite.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';

describe('writeToGroupWithRetry', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let seq = 0;
  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
  });
  after(async () => {
    await local.dispose();
  });

  const addGroup = async () => {
    const groupId = `retry-group-${++seq}`;
    await db
      .prepare(
        `INSERT INTO expense_groups (id, name, currency_code, currency_minor_unit, timezone, created_at)
         VALUES (?, 'g', 'JPY', 0, 'Asia/Tokyo', 1)`,
      )
      .bind(groupId)
      .run();
    return groupId;
  };
  /** 別のリクエストが書いたことにする（バージョンを上げる）。 */
  const interfere = (groupId: string) =>
    db.prepare('UPDATE expense_groups SET data_version = data_version + 1 WHERE id = ?').bind(groupId).run();
  const nonceCount = async (prefix: string) =>
    (await db.prepare('SELECT count(*) AS n FROM used_nonces WHERE nonce_hash LIKE ?').bind(`${prefix}%`).first<{ n: number }>())!.n;
  /** GROUP_WRITE_GUARD の (groupId, token) の両方を束縛した、nonce の追加。 */
  const writeNonce = (groupId: string, token: string, hash: string) =>
    db
      .prepare(`INSERT INTO used_nonces (nonce_hash, expires_at) SELECT ?, 1 WHERE EXISTS (${GROUP_WRITE_GUARD})`)
      .bind(hash, groupId, token);

  it('競合しなければ、1回で書ける', async () => {
    const groupId = await addGroup();
    let plans = 0;
    const outcome = await writeToGroupWithRetry(db, groupId, async () => {
      plans += 1;
      return { value: 'ok', write: (token) => [writeNonce(groupId, token, `retry-a-${groupId}`)] };
    });
    assert.deepEqual(outcome, { status: 'written', value: 'ok' });
    assert.equal(plans, 1);
    assert.equal(await readDataVersion(db, groupId), 1);
    assert.equal(await nonceCount(`retry-a-${groupId}`), 1);
  });

  it('1回競合したら、バージョンから読み直してやり直し、2回目で書ける', async () => {
    const groupId = await addGroup();
    const seenVersions: number[] = [];
    const outcome = await writeToGroupWithRetry(db, groupId, async (version) => {
      seenVersions.push(version);
      if (seenVersions.length === 1) await interfere(groupId); // 読んだあとに、別のリクエストが書いた
      return { value: 'ok', write: (token) => [writeNonce(groupId, token, `retry-b-${groupId}`)] };
    });
    assert.deepEqual(outcome, { status: 'written', value: 'ok' });
    assert.deepEqual(seenVersions, [0, 1]);
    assert.equal(await readDataVersion(db, groupId), 2);
    assert.equal(await nonceCount(`retry-b-${groupId}`), 1);
  });

  it('やり直しても競合したら、書かずに conflict（version）', async () => {
    const groupId = await addGroup();
    let plans = 0;
    const outcome = await writeToGroupWithRetry(db, groupId, async () => {
      plans += 1;
      await interfere(groupId);
      return { value: 'ok', write: (token) => [writeNonce(groupId, token, `retry-c-${groupId}`)] };
    });
    assert.deepEqual(outcome, { status: 'conflict', reason: 'version' });
    assert.equal(plans, 2);
    assert.equal(await readDataVersion(db, groupId), 2); // 別のリクエストの2回分だけ
    assert.equal(await nonceCount(`retry-c-${groupId}`), 0);
  });

  it('試行の回数は変えられる', async () => {
    const groupId = await addGroup();
    let plans = 0;
    const outcome = await writeToGroupWithRetry(
      db,
      groupId,
      async () => {
        plans += 1;
        if (plans <= 2) await interfere(groupId);
        return { value: 'ok', write: (token) => [writeNonce(groupId, token, `retry-d-${groupId}`)] };
      },
      3,
    );
    assert.deepEqual(outcome, { status: 'written', value: 'ok' });
    assert.equal(plans, 3);
  });

  it('断る（reject）と、書かず、バージョンも上げず、やり直さない', async () => {
    const groupId = await addGroup();
    let plans = 0;
    const outcome = await writeToGroupWithRetry<string, { code: number }>(db, groupId, async () => {
      plans += 1;
      return { reject: { code: 404 } };
    });
    assert.deepEqual(outcome, { status: 'rejected', reject: { code: 404 } });
    assert.equal(plans, 1);
    assert.equal(await readDataVersion(db, groupId), 0);
  });

  it('グループが無ければ no_group（plan は呼ばない）', async () => {
    let plans = 0;
    const outcome = await writeToGroupWithRetry(db, 'no-such-group', async () => {
      plans += 1;
      return { value: 'ok', write: () => [] };
    });
    assert.deepEqual(outcome, { status: 'no_group' });
    assert.equal(plans, 0);
  });

  it('一意制約違反はやり直さず conflict（unique）。何も書かれない', async () => {
    const groupId = await addGroup();
    let plans = 0;
    const outcome = await writeToGroupWithRetry(db, groupId, async () => {
      plans += 1;
      return {
        value: 'ok',
        // 同じ主キーを2回入れる。
        write: (token) => [
          writeNonce(groupId, token, `retry-e-${groupId}`),
          writeNonce(groupId, token, `retry-e-${groupId}`),
        ],
      };
    });
    assert.deepEqual(outcome, { status: 'conflict', reason: 'unique' });
    assert.equal(plans, 1);
    assert.equal(await readDataVersion(db, groupId), 0);
    assert.equal(await nonceCount(`retry-e-${groupId}`), 0);
  });
});
