/// <reference types="node" />
// 脱退の確定（src/membership.ts）の検査: 月締めの中での確定と、最後の1人の脱退でのグループの削除。
// 規則は docs/backend-design.md 5章「脱退」・「グループの削除」。月初のCronでの確定は cron.test.ts。
// ローカルD1（miniflare）での検査なので、確かめるのはロジック。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { dueLeaves, isLastMember } from '../src/membership.ts';
import type { MemberInfo } from '../src/monthState.ts';
import {
  createFixtureFactory,
  equalShares,
  insertCategoryRule,
  insertExpenseRow,
  insertInviteRow,
  insertRecurringRow,
  NOW,
  type MemberOptions,
  type Person,
} from './apiFixture.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';
import { monthApi } from './monthApi.ts';

const member = (id: string, overrides: Partial<MemberInfo> = {}): MemberInfo => ({
  id,
  displayName: id,
  status: 'active',
  historyFromMonth: '2026-10',
  expenseEndMonth: null,
  leaveRequestedMonth: null,
  ...overrides,
});

describe('脱退の確定の対象と、最後の1人の判定（純粋な関数）', () => {
  it('dueLeaves: 脱退月が、渡した月以前の、参加中のメンバーだけ', () => {
    const members = [
      member('a', { leaveRequestedMonth: '2026-10' }),
      member('b', { leaveRequestedMonth: '2026-11' }),
      member('c'),
      member('d', { status: 'leaving', leaveRequestedMonth: '2026-10', expenseEndMonth: '2026-10' }),
      member('e', { status: 'left', leaveRequestedMonth: '2026-09', expenseEndMonth: '2026-09' }),
    ];
    assert.deepEqual(dueLeaves(members, '2026-10').map((m) => m.id), ['a']);
    assert.deepEqual(dueLeaves(members, '2026-11').map((m) => m.id), ['a', 'b']);
    assert.deepEqual(dueLeaves(members, '2026-09'), []);
  });

  it('isLastMember: 参加中・脱退が確定したメンバーが、抜ける1人だけのときだけ true', () => {
    const alone = member('a', { leaveRequestedMonth: '2026-10' });
    const others = [member('x', { status: 'left', expenseEndMonth: '2026-09' }), member('y', { status: 'deleted' })];
    assert.equal(isLastMember([alone, ...others], [alone]), true, '脱退済み・削除済みは数えない');
    assert.equal(isLastMember([alone, member('b')], [alone]), false, '残る人がいる');
    assert.equal(
      isLastMember([alone, member('c', { status: 'leaving', expenseEndMonth: '2026-10' })], [alone]),
      false,
      '脱退が確定して、精算を待っている人も、メンバーとして残っている',
    );
    const second = member('b', { leaveRequestedMonth: '2026-10' });
    assert.equal(isLastMember([alone, second], [alone, second]), false, '2人が同時に抜けるときは、精算が残るので消さない');
    assert.equal(isLastMember([alone], []), false, '抜ける人がいなければ false');
  });
});

describe('月締めでの脱退の確定', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let env: Env;
  let factory: ReturnType<typeof createFixtureFactory>;
  let api: ReturnType<typeof monthApi>;

  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
    env = local.env;
    factory = createFixtureFactory(db);
    api = monthApi(env);
  });
  after(async () => {
    await local.dispose();
  });

  const setup = async <Name extends string>(
    names: readonly Name[],
    options: Partial<Record<Name, MemberOptions>> = {},
  ) => {
    const group = await factory.createGroup(names, options);
    const ids = names.map((name) => group.people[name].memberId);
    await insertCategoryRule(db, group.groupId, group.categoryId, '2026-10', equalShares(ids));
    return group;
  };
  const pay = (group: { groupId: string; categoryId: string }, who: Person, amountMinor: number) =>
    insertExpenseRow(db, {
      groupId: group.groupId,
      categoryId: group.categoryId,
      payerMemberId: who.memberId,
      amountMinor,
      targetMonth: '2026-10',
    });

  const memberRow = (memberId: string) =>
    db
      .prepare('SELECT status, expense_end_month, leave_requested_month, left_at FROM group_members WHERE id = ?')
      .bind(memberId)
      .first<{
        status: string;
        expense_end_month: string | null;
        leave_requested_month: string | null;
        left_at: number | null;
      }>();
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
  const settingsOf = (categoryId: string, month: string) =>
    db
      .prepare('SELECT cap_member_id, cap_minor FROM category_month_settings WHERE category_id = ? AND target_month = ?')
      .bind(categoryId, month)
      .first<{ cap_member_id: string | null; cap_minor: number | null }>();
  const pausedReason = async (recurringId: string) =>
    (
      await db
        .prepare('SELECT paused_reason FROM recurring_expenses WHERE id = ?')
        .bind(recurringId)
        .first<{ paused_reason: string | null }>()
    )!.paused_reason;
  const inviteRow = (inviteId: string) =>
    db
      .prepare('SELECT revoked_at, consumed_at FROM invites WHERE id = ?')
      .bind(inviteId)
      .first<{ revoked_at: number | null; consumed_at: number | null }>();

  it('脱退月を締めると、脱退が確定する: 状態・翌月の割合のリセット・招待の取り消し・固定費の停止', async () => {
    const g = await setup(['alice', 'bob', 'carol'], { alice: { leaveRequestedMonth: '2026-10' } });
    const { alice, bob, carol } = g.people;
    const archivedId = await factory.addCategory(g.groupId, 'old', true);
    await insertCategoryRule(db, g.groupId, archivedId, '2026-10', equalShares([alice, bob, carol].map((p) => p.memberId)));
    // 翌月（2026-11）の割合が、すでに上限額つきで書かれている。リセットで、割合も上限額も置き換わる。
    await insertCategoryRule(
      db,
      g.groupId,
      g.categoryId,
      '2026-11',
      [
        [alice.memberId, 7000],
        [bob.memberId, 3000],
      ],
      { memberId: bob.memberId, capMinor: 5000 },
    );
    await pay(g, alice, 9000); // bob → alice 3,000、carol → alice 3,000。aliceが関わる送金が残る。

    const aliceInvite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId });
    const aliceUsed = await insertInviteRow(db, {
      groupId: g.groupId,
      invitedByMemberId: alice.memberId,
      consumed: { memberId: bob.memberId, at: NOW },
    });
    const aliceRevoked = await insertInviteRow(db, {
      groupId: g.groupId,
      invitedByMemberId: alice.memberId,
      revokedAt: 12345,
    });
    const bobInvite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: bob.memberId });

    const aliceCategory = await insertRecurringRow(db, { groupId: g.groupId, categoryId: g.categoryId, payerMemberId: alice.memberId });
    const aliceFixed = await insertRecurringRow(db, {
      groupId: g.groupId,
      categoryId: g.categoryId,
      payerMemberId: alice.memberId,
      splitMethod: 'fixed',
    });
    const bobEqual = await insertRecurringRow(db, {
      groupId: g.groupId,
      categoryId: g.categoryId,
      payerMemberId: bob.memberId,
      splitMethod: 'equal',
    });
    const bobCategory = await insertRecurringRow(db, { groupId: g.groupId, categoryId: g.categoryId, payerMemberId: bob.memberId });
    const bobManual = await insertRecurringRow(db, {
      groupId: g.groupId,
      categoryId: g.categoryId,
      payerMemberId: bob.memberId,
      splitMethod: 'fixed',
      pausedReason: 'manual',
    });

    const closed = await api.close(bob, g.groupId, '2026-10');
    assert.equal(closed.status, 201, JSON.stringify(closed.body));

    // 脱退が確定する。送金が残っているので、脱退済みにはならない。
    assert.deepEqual(await memberRow(alice.memberId), {
      status: 'leaving',
      expense_end_month: '2026-10',
      leave_requested_month: '2026-10',
      left_at: null,
    });
    assert.equal((await memberRow(bob.memberId))!.status, 'active');

    // 翌月の全費目（アーカイブ済みも）の割合が、残る2人での均等になり、上限額は外れる。
    for (const categoryId of [g.categoryId, archivedId]) {
      assert.deepEqual(await sharesOf(categoryId, '2026-11'), [
        [bob.memberId, 5000],
        [carol.memberId, 5000],
      ]);
      assert.deepEqual(await settingsOf(categoryId, '2026-11'), { cap_member_id: null, cap_minor: null });
    }
    // 締めた月の割合は変わらない（3人の均等）。
    assert.equal((await sharesOf(g.categoryId, '2026-10')).length, 3);

    // 発行した未使用の招待だけが取り消される。
    assert.notEqual((await inviteRow(aliceInvite.id))!.revoked_at, null);
    assert.deepEqual(await inviteRow(aliceUsed.id), { revoked_at: null, consumed_at: NOW });
    assert.equal((await inviteRow(aliceRevoked.id))!.revoked_at, 12345, '取り消し済みの時刻は上書きしない');
    assert.equal((await inviteRow(bobInvite.id))!.revoked_at, null);

    // 固定費: 脱退者が支払者のものは payer_left、category 以外は member_changed。止まっているものの理由は変えない。
    assert.equal(await pausedReason(aliceCategory), 'payer_left');
    assert.equal(await pausedReason(aliceFixed), 'payer_left', '支払者が対象のものは、payer_left を先にする');
    assert.equal(await pausedReason(bobEqual), 'member_changed');
    assert.equal(await pausedReason(bobCategory), null);
    assert.equal(await pausedReason(bobManual), 'manual');
  });

  it('関わる送金が0件なら、締めた時点で脱退済みになる', async () => {
    const g = await setup(['alice', 'bob'], { alice: { leaveRequestedMonth: '2026-10' } });
    const closed = await api.close(g.people.bob, g.groupId, '2026-10');
    assert.equal(closed.status, 201);
    assert.equal(closed.body.transfers.length, 0);
    const row = await memberRow(g.people.alice.memberId);
    assert.deepEqual([row!.status, row!.expense_end_month, row!.left_at], ['left', '2026-10', NOW]);
  });

  it('別の月を脱退月に選んでいるメンバーは、確定しない（翌月に脱退を選んだ人は、10月を締めても参加中）', async () => {
    const g = await setup(['alice', 'bob'], { alice: { leaveRequestedMonth: '2026-11' } });
    assert.equal((await api.close(g.people.bob, g.groupId, '2026-10')).status, 201);
    assert.deepEqual(await memberRow(g.people.alice.memberId), {
      status: 'active',
      expense_end_month: null,
      leave_requested_month: '2026-11',
      left_at: null,
    });
    // 割合のリセットも起きない（締めた月の行だけが、引き継ぎで書かれる）。
    assert.equal((await sharesOf(g.categoryId, '2026-11')).length, 0);
  });

  it('脱退月が「飛ばした月」のとき（最初の締めが、それより後の月）も、締める月・締めた月の割合は、リセットしない', async () => {
    // 作成月（2026-10）を脱退月に選んだ alice が、Cronの確定の前に、最初の支出がある月（2026-11）の締めを迎える。
    // 確定の翌月（2026-11）は、いま締める月なので、リセットの対象にしない（締める月の割合は、引き継ぎで書く）。
    const g = await setup(['alice', 'bob'], { alice: { leaveRequestedMonth: '2026-10' } });
    await insertExpenseRow(db, {
      groupId: g.groupId,
      categoryId: g.categoryId,
      payerMemberId: g.people.bob.memberId,
      amountMinor: 6000,
      targetMonth: '2026-11',
    });
    const closed = await api.close(g.people.bob, g.groupId, '2026-11');
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.deepEqual(await memberRow(g.people.alice.memberId), {
      status: 'leaving',
      expense_end_month: '2026-10',
      leave_requested_month: '2026-10',
      left_at: null,
    });
    // 2026-11 の割合は、引き継ぎで書かれた2人の均等のまま（alice は脱退月 2026-10 を過ぎているが、締めた月は確定している）。
    assert.equal((await sharesOf(g.categoryId, '2026-11')).length, 2);
    assert.equal((await sharesOf(g.categoryId, '2026-12')).length, 0);
  });

  it('2人が同時に脱退を確定しても、グループは消えない（お互いの精算が残る）。確定した翌月に参加する人はいないので、割合は書かない', async () => {
    const g = await setup(['alice', 'bob'], {
      alice: { leaveRequestedMonth: '2026-10' },
      bob: { leaveRequestedMonth: '2026-10' },
    });
    await pay(g, g.people.alice, 6000);
    const closed = await api.close(g.people.alice, g.groupId, '2026-10');
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.equal((await memberRow(g.people.alice.memberId))!.status, 'leaving');
    assert.equal((await memberRow(g.people.bob.memberId))!.status, 'leaving');
    assert.equal((await sharesOf(g.categoryId, '2026-11')).length, 0);
    // 送金は精算できる（グループが残っている）。
    assert.equal((await api.settle(g.people.bob, closed.body.transfers[0].id)).status, 200);
  });

  describe('最後の1人の脱退（グループの削除）', () => {
    const TABLES = [
      'settlement_transfers',
      'closing_category_burdens',
      'closing_member_summaries',
      'monthly_closings',
      'expense_allocations',
      'expenses',
      'recurring_expense_runs',
      'recurring_expense_allocations',
      'recurring_expenses',
      'category_month_shares',
      'category_month_settings',
      'categories',
      'invites',
      'group_members',
    ];
    const countRows = async (groupId: string) => {
      const counts: Record<string, number> = {};
      for (const table of TABLES) {
        counts[table] = (
          await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE group_id = ?`).bind(groupId).first<{ n: number }>()
        )!.n;
      }
      counts.expense_groups = (
        await db.prepare('SELECT count(*) AS n FROM expense_groups WHERE id = ?').bind(groupId).first<{ n: number }>()
      )!.n;
      return counts;
    };

    it('脱退月を締めると、締めずに、グループのデータがすべて消える。ほかのグループは消えない', async () => {
      const g = await setup(['alice'], { alice: { leaveRequestedMonth: '2026-10' } });
      const other = await setup(['zed']);
      await pay(g, g.people.alice, 5000);
      await pay(other, other.people.zed, 5000);
      await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      await insertRecurringRow(db, { groupId: g.groupId, categoryId: g.categoryId, payerMemberId: g.people.alice.memberId });
      const before = await countRows(g.groupId);
      assert.ok(before.expenses > 0 && before.invites > 0 && before.recurring_expenses > 0 && before.group_members > 0);
      const otherBefore = await countRows(other.groupId);

      const result = await api.close(g.people.alice, g.groupId, '2026-10');
      assert.deepEqual([result.status, result.body], [200, { groupDeleted: true }]);

      for (const [table, count] of Object.entries(await countRows(g.groupId))) assert.equal(count, 0, table);
      assert.deepEqual(await countRows(other.groupId), otherBefore);
    });

    it('最後の1人でも、脱退月を選んでいなければ、普通に締まる', async () => {
      const g = await setup(['alice']);
      assert.equal((await api.close(g.people.alice, g.groupId, '2026-10')).status, 201);
      assert.equal((await countRows(g.groupId)).expense_groups, 1);
    });

    it('脱退済み・削除済みのメンバーがいても、参加中の1人だけなら、最後の1人', async () => {
      const g = await setup(['alice'], { alice: { leaveRequestedMonth: '2026-10' } });
      await factory.addMember(g.groupId, 'erin', null, { status: 'left', expenseEndMonth: '2026-09' });
      await factory.addMember(g.groupId, 'dave', null, { status: 'deleted', expenseEndMonth: '2026-09' });
      const result = await api.close(g.people.alice, g.groupId, '2026-10');
      assert.deepEqual([result.status, result.body], [200, { groupDeleted: true }]);
      assert.equal((await countRows(g.groupId)).expense_groups, 0);
    });
  });
});
