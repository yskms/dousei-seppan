/// <reference types="node" />
// 送金の精算済み・繰越のAPI（src/transfers.ts）の検査。規則は docs/backend-design.md 4章「精算と繰越」・5章（脱退）・
// 8章、形は9章「月締め・精算API」。ローカルD1（miniflare）での検査なので、確かめるのはロジック。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createFixtureFactory,
  equalShares,
  insertCategoryRule,
  insertExpenseRow,
  NOW,
  type MemberOptions,
  type Person,
} from './apiFixture.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';
import { interferingEnv, monthApi } from './monthApi.ts';

describe('送金の精算済み・繰越のAPI', () => {
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

  // --- 準備の道具 -------------------------------------------------------------------------------

  const setup = async <Name extends string>(
    names: readonly Name[],
    options: Partial<Record<Name, MemberOptions>> = {},
  ) => {
    const group = await factory.createGroup(names, options);
    const ids = names.map((name) => group.people[name].memberId);
    await insertCategoryRule(db, group.groupId, group.categoryId, '2026-10', equalShares(ids));
    return group;
  };
  const pay = (group: { groupId: string; categoryId: string }, who: Person, amountMinor: number, month = '2026-10') =>
    insertExpenseRow(db, {
      groupId: group.groupId,
      categoryId: group.categoryId,
      payerMemberId: who.memberId,
      amountMinor,
      targetMonth: month,
    });

  interface TransferView {
    id: string;
    fromMemberId: string;
    toMemberId: string;
    amountMinor: number;
    status: string;
    canCarry: boolean;
  }
  /** alice と bob の2人で、alice が6,000円払って10月を締める。送金は bob → alice の3,000円が1件。 */
  const closedTwoPeople = async () => {
    const g = await setup(['alice', 'bob']);
    await pay(g, g.people.alice, 6000);
    const closed = await api.close(g.people.alice, g.groupId, '2026-10');
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    return { g, transfer: closed.body.transfers[0] as TransferView };
  };

  const dataVersion = async (groupId: string) =>
    (await db.prepare('SELECT data_version FROM expense_groups WHERE id = ?').bind(groupId).first<{ data_version: number }>())!
      .data_version;
  const transferRow = (transferId: string) =>
    db.prepare('SELECT * FROM settlement_transfers WHERE id = ?').bind(transferId).first<Record<string, unknown>>();
  const memberRow = (memberId: string) =>
    db
      .prepare('SELECT status, left_at FROM group_members WHERE id = ?')
      .bind(memberId)
      .first<{ status: string; left_at: number | null }>();
  const bump = (groupId: string) =>
    db.prepare('UPDATE expense_groups SET data_version = data_version + 1 WHERE id = ?').bind(groupId).run();

  // === 精算済み・繰越 ===========================================================================

  describe('状態の変更（pending → settled / carried）', () => {
    it('精算済みにする: 状態・日時・操作したメンバーが残り、バージョンが上がる', async () => {
      const { g, transfer } = await closedTwoPeople();
      const before = await dataVersion(g.groupId);

      const result = await api.settle(g.people.bob, transfer.id);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        transfer: {
          id: transfer.id,
          fromMemberId: g.people.bob.memberId,
          toMemberId: g.people.alice.memberId,
          amountMinor: 3000,
          status: 'settled',
          settledAt: NOW,
          carriedAt: null,
          processedByMemberId: g.people.bob.memberId,
          canCarry: false,
        },
      });
      const row = await transferRow(transfer.id);
      assert.deepEqual([row!.status, row!.settled_at, row!.carried_at, row!.processed_by_member_id], [
        'settled',
        NOW,
        null,
        g.people.bob.memberId,
      ]);
      assert.equal(await dataVersion(g.groupId), before + 1);
    });

    it('次の月に繰り越す: 状態・日時・操作したメンバーが残る', async () => {
      const { g, transfer } = await closedTwoPeople();
      const result = await api.carry(g.people.alice, transfer.id);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.transfer, {
        ...transfer,
        status: 'carried',
        settledAt: null,
        carriedAt: NOW,
        processedByMemberId: g.people.alice.memberId,
        canCarry: false,
      });
      const row = await transferRow(transfer.id);
      assert.deepEqual([row!.status, row!.settled_at, row!.carried_at], ['carried', null, NOW]);
    });

    it('settled・carried から別の状態へは変えられない（409 transfer_not_pending）。何も書かれない', async () => {
      for (const [first, second, status] of [
        ['settle', 'settle', 'settled'],
        ['settle', 'carry', 'settled'],
        ['carry', 'settle', 'carried'],
        ['carry', 'carry', 'carried'],
      ] as const) {
        const { g, transfer } = await closedTwoPeople();
        assert.equal((await api[first](g.people.bob, transfer.id)).status, 200);
        const before = await dataVersion(g.groupId);
        const rowBefore = await transferRow(transfer.id);

        const result = await api[second](g.people.alice, transfer.id);
        assert.deepEqual([result.status, result.body], [409, { error: 'transfer_not_pending', status }], `${first} → ${second}`);
        assert.equal(await dataVersion(g.groupId), before);
        assert.deepEqual(await transferRow(transfer.id), rowBefore);
      }
    });

    it('送金の当事者でないメンバーも、操作できる（全メンバーが操作できる）', async () => {
      const g = await setup(['alice', 'bob', 'carol']);
      await pay(g, g.people.alice, 9000); // bob → alice 3,000、carol → alice 3,000
      const closed = (await api.close(g.people.alice, g.groupId, '2026-10')).body;
      const toAlice = closed.transfers.find((t: TransferView) => t.fromMemberId === g.people.bob.memberId) as TransferView;

      const result = await api.settle(g.people.carol, toAlice.id);
      assert.equal(result.status, 200);
      assert.equal(result.body.transfer.processedByMemberId, g.people.carol.memberId);
    });

    it('月は、すべての送金が settled か carried になった時点で処理済みになる（混在してよい）', async () => {
      const g = await setup(['alice', 'bob', 'carol']);
      await pay(g, g.people.alice, 9000);
      const closed = (await api.close(g.people.alice, g.groupId, '2026-10')).body;
      assert.equal(closed.transfers.length, 2);
      const processed = async () => (await api.closing(g.people.alice, g.groupId, '2026-10')).body.closing.processed;
      assert.equal(await processed(), false);

      assert.equal((await api.settle(g.people.alice, closed.transfers[0].id)).status, 200);
      assert.equal(await processed(), false, '1件が未処理のまま');
      assert.equal((await api.carry(g.people.alice, closed.transfers[1].id)).status, 200);
      assert.equal(await processed(), true);
    });
  });

  describe('繰り越せない送金（4章）', () => {
    // 締めたあとで、メンバーの状態を変える。繰越だけが断られ、精算済みにはできる。
    const states: [string, string][] = [
      ['脱退を選んだ（leave_requested_month あり）', `UPDATE group_members SET leave_requested_month = '2026-11' WHERE id = ?`],
      ['脱退が確定した（leaving）', `UPDATE group_members SET status = 'leaving', expense_end_month = '2026-10' WHERE id = ?`],
      ['削除したユーザー（deleted）', `UPDATE group_members SET status = 'deleted', user_id = NULL, display_name = '削除されたユーザー' WHERE id = ?`],
    ];
    for (const side of ['from', 'to'] as const) {
      for (const [label, sql] of states) {
        it(`送金${side === 'from' ? '元' : '先'}が「${label}」なら、繰り越せず、精算済みにはできる`, async () => {
          const { g, transfer } = await closedTwoPeople();
          const target = side === 'from' ? transfer.fromMemberId : transfer.toMemberId;
          // 状態を変えたメンバーとは別のメンバーが操作する（削除したユーザーはログインできない）。
          const actor = side === 'from' ? g.people.alice : g.people.bob;
          await db.prepare(sql).bind(target).run();
          // 締め結果にも、繰越できないことが出る。
          const view = (await api.closing(actor, g.groupId, '2026-10')).body;
          assert.equal(view.transfers[0].canCarry, false);

          const before = await dataVersion(g.groupId);
          const carry = await api.carry(actor, transfer.id);
          assert.deepEqual([carry.status, carry.body], [409, { error: 'transfer_not_carryable' }]);
          assert.equal(await dataVersion(g.groupId), before);
          assert.equal((await transferRow(transfer.id))!.status, 'pending');

          // 脱退予定・削除したユーザーとの送金も、残るメンバーが確認して精算済みにできる。
          assert.equal((await api.settle(actor, transfer.id)).status, 200);
        });
      }
    }

    it('繰り越せる送金は canCarry が true', async () => {
      const { g } = await closedTwoPeople();
      const view = (await api.closing(g.people.alice, g.groupId, '2026-10')).body;
      assert.equal(view.transfers[0].canCarry, true);
    });
  });

  describe('脱退が確定したメンバー（5章）', () => {
    it('関わる送金がすべて精算済みになった時点で、脱退済み（left）になる', async () => {
      const g = await setup(['alice', 'bob', 'carol'], { carol: { status: 'leaving', expenseEndMonth: '2026-10' } });
      const { alice, bob, carol } = g.people;
      await pay(g, carol, 3000); // alice → carol 1,001 と bob → carol 1,000（端数は先頭へ）
      const closed = (await api.close(alice, g.groupId, '2026-10')).body;
      assert.equal(closed.transfers.length, 2);
      assert.equal((await memberRow(carol.memberId))!.status, 'leaving');

      // 脱退者が関わる送金は繰り越せない。精算済みにする。1件が残っているうちは leaving のまま。
      assert.equal((await api.settle(bob, closed.transfers[0].id)).status, 200);
      assert.equal((await memberRow(carol.memberId))!.status, 'leaving');
      assert.equal((await api.settle(bob, closed.transfers[1].id)).status, 200);
      assert.deepEqual(await memberRow(carol.memberId), { status: 'left', left_at: NOW });
      // 関わらないメンバーは変わらない。
      assert.equal((await memberRow(alice.memberId))!.status, 'active');
      // 脱退済みになると、グループのデータは見られない（404）。
      assert.equal((await api.closing(carol, g.groupId, '2026-10')).status, 404);
    });

    it('leaving のメンバーも、精算済みにできる（グループのデータを見られ、精算に参加する）', async () => {
      const g = await setup(['alice', 'bob', 'carol'], { carol: { status: 'leaving', expenseEndMonth: '2026-10' } });
      await pay(g, g.people.alice, 9000);
      const closed = (await api.close(g.people.alice, g.groupId, '2026-10')).body;
      const result = await api.settle(g.people.carol, closed.transfers[0].id);
      assert.equal(result.status, 200);
    });
  });

  describe('権限（共通の判定）', () => {
    it('認証・所属・月の閲覧範囲の判定', async () => {
      const f = await factory();
      await insertCategoryRule(db, f.groupId, f.categoryId, '2026-10', equalShares([f.alice.memberId, f.bob.memberId]));
      await insertExpenseRow(db, {
        groupId: f.groupId,
        categoryId: f.categoryId,
        payerMemberId: f.alice.memberId,
        amountMinor: 6000,
        targetMonth: '2026-10',
      });
      const closed = (await api.close(f.alice, f.groupId, '2026-10')).body;
      const transfers = closed.transfers as TransferView[];
      assert.ok(transfers.length > 0);
      const id = transfers[0]!.id;
      const before = await dataVersion(f.groupId);

      assert.deepEqual((await api.settle(null, id)).body, { error: 'unauthorized' });
      for (const who of [f.outsider, f.other.member, f.erin, f.newbie]) {
        // メンバーでない人、他のグループ、脱退済み、参加前の月（10月より後に参加したメンバー）は、区別せず404。
        for (const action of ['settle', 'carry'] as const) {
          const result = await api[action](who, id);
          assert.deepEqual([result.status, result.body], [404, { error: 'not_found' }]);
        }
      }
      assert.deepEqual((await api.settle(f.alice, 'no-such-transfer')).body, { error: 'not_found' });
      assert.equal(await dataVersion(f.groupId), before);
      assert.equal((await transferRow(id))!.status, 'pending');
    });
  });

  describe('競合（8章）', () => {
    it('検証のあとに別のリクエストが書いたら、やり直さずに409（conflict）で、何も書かれない', async () => {
      const { g, transfer } = await closedTwoPeople();
      const before = await dataVersion(g.groupId);

      const result = await api.settle(g.people.bob, transfer.id, {
        env: interferingEnv(env, () => bump(g.groupId), { skipBatches: 1 }),
      });
      assert.deepEqual([result.status, result.body], [409, { error: 'conflict' }]);
      assert.equal((await transferRow(transfer.id))!.status, 'pending');
      assert.equal(await dataVersion(g.groupId), before + 1);

      // 読み直して、もう一度。
      assert.equal((await api.settle(g.people.bob, transfer.id)).status, 200);
    });

    it('同じ送金を同時に操作すると、片方だけが効く（先に書いたほうが残る）', async () => {
      const { g, transfer } = await closedTwoPeople();
      const { alice, bob } = g.people;
      // bob が「繰越」を読んだあと、書く前に、alice が「精算済み」にした。
      const result = await api.carry(bob, transfer.id, {
        env: interferingEnv(env, async () => {
          assert.equal((await api.settle(alice, transfer.id)).status, 200);
        }, { skipBatches: 1 }),
      });
      assert.deepEqual([result.status, result.body], [409, { error: 'conflict' }]);
      const row = await transferRow(transfer.id);
      assert.deepEqual([row!.status, row!.processed_by_member_id], ['settled', alice.memberId]);
    });

    it('別の送金の操作が間に入っても、古い読み取りのまま書かない（1件ずつ409になり、読み直せばよい）', async () => {
      const g = await setup(['alice', 'bob', 'carol']);
      await pay(g, g.people.alice, 9000);
      const closed = (await api.close(g.people.alice, g.groupId, '2026-10')).body;
      const [first, second] = closed.transfers as TransferView[];

      const result = await api.settle(g.people.alice, second!.id, {
        env: interferingEnv(env, async () => {
          assert.equal((await api.settle(g.people.alice, first!.id)).status, 200);
        }, { skipBatches: 1 }),
      });
      assert.equal(result.status, 409);
      assert.equal((await transferRow(second!.id))!.status, 'pending');
      assert.equal((await api.settle(g.people.alice, second!.id)).status, 200);
    });
  });
});
