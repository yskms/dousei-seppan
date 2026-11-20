/// <reference types="node" />
// 定期処理（src/cron.ts）の検査: 月初の、脱退月が終わったのに締められていない脱退の確定。
// 規則は docs/backend-design.md 5章・7章。ローカルD1（miniflare）での検査なので、確かめるのはロジック。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import worker from '../src/index.ts';
import { MAX_GROUPS_PER_RUN, runScheduled } from '../src/cron.ts';
import {
  createFixtureFactory,
  equalShares,
  insertCategoryRule,
  insertClosing,
  insertInviteRow,
  insertRecurringRow,
  NOW,
  type MemberOptions,
} from './apiFixture.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';
import { interferingEnv, NOW_DECEMBER } from './monthApi.ts';

/** 2026-11-30 23:30（Asia/Tokyo）。11月はまだ終わっていない。 */
const NOV_30_2330_JST = Date.UTC(2026, 10, 30, 14, 30, 0);
/** 2026-12-01 00:30（Asia/Tokyo）。11月が終わった。 */
const DEC_01_0030_JST = Date.UTC(2026, 10, 30, 15, 30, 0);

describe('定期処理: 月初の脱退の確定', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let env: Env;
  let factory: ReturnType<typeof createFixtureFactory>;

  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
    env = local.env;
    factory = createFixtureFactory(db);
  });
  after(async () => {
    await local.dispose();
  });

  /** 11月を脱退月に選んだ alice と、bob・carol のグループ（10月から参加）。11月は締めていない。 */
  const setup = async (options: Partial<Record<'alice' | 'bob' | 'carol', MemberOptions>> = {}) => {
    const names = ['alice', 'bob', 'carol'] as const;
    const group = await factory.createGroup(names, { alice: { leaveRequestedMonth: '2026-11' }, ...options });
    const ids = names.map((name) => group.people[name].memberId);
    await insertCategoryRule(db, group.groupId, group.categoryId, '2026-10', equalShares(ids));
    return group;
  };
  const memberRow = (memberId: string) =>
    db
      .prepare('SELECT status, expense_end_month, left_at FROM group_members WHERE id = ?')
      .bind(memberId)
      .first<{ status: string; expense_end_month: string | null; left_at: number | null }>();
  const dataVersion = async (groupId: string) =>
    (await db.prepare('SELECT data_version FROM expense_groups WHERE id = ?').bind(groupId).first<{ data_version: number }>())!
      .data_version;
  const sharesOf = async (categoryId: string, month: string) =>
    (
      await db
        .prepare(
          `SELECT member_id, share_basis_points FROM category_month_shares
            WHERE category_id = ? AND target_month = ? ORDER BY member_id`,
        )
        .bind(categoryId, month)
        .all<{ member_id: string; share_basis_points: number }>()
    ).results.map((row) => [row.member_id, row.share_basis_points]);

  it('脱退月が終わっていれば確定する: 状態・翌月の割合のリセット・招待の取り消し・固定費の停止', async () => {
    const g = await setup();
    const { alice, bob, carol } = g.people;
    const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId });
    const recurring = await insertRecurringRow(db, { groupId: g.groupId, categoryId: g.categoryId, payerMemberId: alice.memberId });

    const summary = await runScheduled(env, NOW_DECEMBER);
    assert.ok(summary.confirmedGroups.includes(g.groupId));

    // 11月が締められていないので、脱退済みにはならず、`leaving` のまま。
    assert.deepEqual(await memberRow(alice.memberId), { status: 'leaving', expense_end_month: '2026-11', left_at: null });
    assert.deepEqual(await sharesOf(g.categoryId, '2026-12'), [
      [bob.memberId, 5000],
      [carol.memberId, 5000],
    ]);
    assert.notEqual(
      (await db.prepare('SELECT revoked_at FROM invites WHERE id = ?').bind(invite.id).first<{ revoked_at: number | null }>())!
        .revoked_at,
      null,
    );
    assert.equal(
      (
        await db
          .prepare('SELECT paused_reason FROM recurring_expenses WHERE id = ?')
          .bind(recurring)
          .first<{ paused_reason: string }>()
      )!.paused_reason,
      'payer_left',
    );
  });

  it('冪等: 2回動かしても、2回目は何も変えない（バージョンも上がらない）', async () => {
    const g = await setup();
    await runScheduled(env, NOW_DECEMBER);
    const version = await dataVersion(g.groupId);
    const second = await runScheduled(env, NOW_DECEMBER);
    assert.ok(!second.confirmedGroups.includes(g.groupId));
    assert.equal(await dataVersion(g.groupId), version);
  });

  it('脱退月が終わっていなければ確定しない。判定はグループのタイムゾーン（Asia/Tokyo）の月', async () => {
    const g = await setup();
    // 現在は2026-11-19（JST）。UTCではすでに11/30の15時台でも、JSTの11月30日 23:30 はまだ11月。
    for (const now of [NOW, NOV_30_2330_JST]) {
      const summary = await runScheduled(env, now);
      assert.ok(!summary.confirmedGroups.includes(g.groupId), String(now));
      assert.equal((await memberRow(g.people.alice.memberId))!.status, 'active');
    }
    const summary = await runScheduled(env, DEC_01_0030_JST);
    assert.ok(summary.confirmedGroups.includes(g.groupId));
    assert.equal((await memberRow(g.people.alice.memberId))!.status, 'leaving');
  });

  it('脱退月がすでに締められていて、関わる送金が無ければ、確定と同時に脱退済みになる', async () => {
    const g = await setup();
    await insertClosing(db, g.groupId, '2026-11', g.people.bob.memberId);
    const summary = await runScheduled(env, NOW_DECEMBER);
    assert.ok(summary.confirmedGroups.includes(g.groupId));
    const row = await memberRow(g.people.alice.memberId);
    assert.deepEqual([row!.status, row!.expense_end_month, row!.left_at], ['left', '2026-11', NOW_DECEMBER]);
  });

  it('利用者の操作と競合したら、何も変えずに次の回に回す。次の回で確定する', async () => {
    const g = await setup();
    const bump = () =>
      db.prepare('UPDATE expense_groups SET data_version = data_version + 1 WHERE id = ?').bind(g.groupId).run();
    const first = await runScheduled(interferingEnv(env, bump), NOW_DECEMBER);
    assert.ok(first.deferredGroups.includes(g.groupId));
    assert.ok(!first.confirmedGroups.includes(g.groupId));
    assert.equal((await memberRow(g.people.alice.memberId))!.status, 'active');
    assert.equal((await sharesOf(g.categoryId, '2026-12')).length, 0);

    const second = await runScheduled(env, NOW_DECEMBER);
    assert.ok(second.confirmedGroups.includes(g.groupId));
    assert.equal((await memberRow(g.people.alice.memberId))!.status, 'leaving');
  });

  it('1つのグループの失敗で、ほかのグループを止めない。失敗は、最後に投げる', async () => {
    // このファイルの他のテストは、自分のグループを確定させて終わっているので、ここで残っている確定待ちは、この2つだけ。
    const g1 = await setup();
    const g2 = await setup();
    // 最初のグループの書き込み（batch）だけが、障害で失敗する。
    const failing = interferingEnv(env, async () => {
      throw new Error('D1の障害');
    });
    await assert.rejects(runScheduled(failing, NOW_DECEMBER), /失敗したグループがある/);
    const statuses = await Promise.all(
      [g1, g2].map(async (g) => (await memberRow(g.people.alice.memberId))!.status),
    );
    assert.deepEqual([...statuses].sort(), ['active', 'leaving'], '1つは失敗し、もう1つは確定している');
    // 失敗したほうは、次の回で確定する。
    await runScheduled(env, NOW_DECEMBER);
    assert.deepEqual(
      await Promise.all([g1, g2].map(async (g) => (await memberRow(g.people.alice.memberId))!.status)),
      ['leaving', 'leaving'],
    );
  });

  it('最後の1人の脱退は、確定と同時にグループを削除する', async () => {
    const g = await factory.createGroup(['alice'], { alice: { leaveRequestedMonth: '2026-11' } });
    await insertCategoryRule(db, g.groupId, g.categoryId, '2026-10', equalShares([g.people.alice.memberId]));
    const summary = await runScheduled(env, NOW_DECEMBER);
    assert.ok(summary.confirmedGroups.includes(g.groupId));
    assert.equal(
      (await db.prepare('SELECT count(*) AS n FROM expense_groups WHERE id = ?').bind(g.groupId).first<{ n: number }>())!.n,
      0,
    );
    assert.equal(
      (await db.prepare('SELECT count(*) AS n FROM group_members WHERE group_id = ?').bind(g.groupId).first<{ n: number }>())!.n,
      0,
    );
  });

  it('入口の scheduled が、定期処理を呼ぶ', async () => {
    const g = await setup();
    await worker.scheduled({ scheduledTime: NOW_DECEMBER, cron: '0 * * * *', noRetry() {} }, env);
    assert.equal((await memberRow(g.people.alice.memberId))!.status, 'leaving');
  });
});

describe('定期処理: 1回の実行の上限', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let env: Env;
  let factory: ReturnType<typeof createFixtureFactory>;

  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
    env = local.env;
    factory = createFixtureFactory(db);
  });
  after(async () => {
    await local.dispose();
  });

  it(`1回に確定するのは ${MAX_GROUPS_PER_RUN} グループまで。残りは次の回が引き受ける`, async () => {
    const groupIds: string[] = [];
    for (let i = 0; i < MAX_GROUPS_PER_RUN + 2; i++) {
      const g = await factory.createGroup(['alice', 'bob'], { alice: { leaveRequestedMonth: '2026-11' } });
      await insertCategoryRule(db, g.groupId, g.categoryId, '2026-10', equalShares([g.people.alice.memberId, g.people.bob.memberId]));
      groupIds.push(g.groupId);
    }
    const first = await runScheduled(env, NOW_DECEMBER);
    assert.equal(first.confirmedGroups.length, MAX_GROUPS_PER_RUN);
    const second = await runScheduled(env, NOW_DECEMBER);
    assert.equal(second.confirmedGroups.length, 2);
    assert.deepEqual([...first.confirmedGroups, ...second.confirmedGroups].sort(), [...groupIds].sort());
    assert.equal((await runScheduled(env, NOW_DECEMBER)).confirmedGroups.length, 0);
  });
});
