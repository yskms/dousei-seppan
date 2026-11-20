/// <reference types="node" />
// 月の一覧（GET /groups/:id/months。src/monthList.ts）の検査。規則は docs/backend-design.md 9章「月締め・精算API」の
// 「月の一覧」、範囲は同8章「支出の対象月」。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import worker from '../src/index.ts';
import { buildMonthList } from '../src/monthList.ts';
import {
  createFixtureFactory,
  equalShares,
  insertCategoryRule,
  insertExpenseRow,
  type MemberOptions,
  type Person,
} from './apiFixture.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';
import { countingEnv, monthApi, NOW_DECEMBER, read, request } from './monthApi.ts';

describe('buildMonthList（DBを読まない組み立て）', () => {
  const none = new Map<string, { hasPending: boolean }>();

  it('範囲の月を古い順に並べ、年をまたぐ', () => {
    const list = buildMonthList({ fromMonth: '2026-11', toMonth: '2027-02', closedMonths: none, latestClosedMonth: null });
    assert.deepEqual(
      list.map((entry) => entry.month),
      ['2026-11', '2026-12', '2027-01', '2027-02'],
    );
  });

  it('始まりが終わりより後なら空', () => {
    assert.deepEqual(
      buildMonthList({ fromMonth: '2026-12', toMonth: '2026-11', closedMonths: none, latestClosedMonth: null }),
      [],
    );
  });

  it('状態は、締めの有無・未処理の送金・最後に締めた月との前後で決まる', () => {
    const closed = new Map([
      ['2026-09', { hasPending: false }],
      ['2026-10', { hasPending: true }],
    ]);
    const list = buildMonthList({
      fromMonth: '2026-07',
      toMonth: '2026-11',
      closedMonths: closed,
      latestClosedMonth: '2026-10',
    });
    assert.deepEqual(list, [
      { month: '2026-07', status: 'skipped' },
      { month: '2026-08', status: 'skipped' },
      { month: '2026-09', status: 'settled' },
      { month: '2026-10', status: 'unsettled' },
      { month: '2026-11', status: 'open' },
    ]);
  });
});

describe('月の一覧API', () => {
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

  /** 名前のメンバーが2026-10から参加しているグループ（作成月も2026-10）。2026-10の費目の割合は均等。 */
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

  const statuses = (result: Awaited<ReturnType<typeof api.months>>) =>
    result.body.months.map((entry: { month: string; status: string }) => `${entry.month}:${entry.status}`);

  it('締めがまだ無ければ、参加した月から今月までが、すべて未締め', async () => {
    const g = await setup(['alice', 'bob']);

    const result = await api.months(g.people.alice, g.groupId);
    assert.equal(result.status, 200);
    assert.equal(result.body.currentMonth, '2026-11');
    assert.deepEqual(statuses(result), ['2026-10:open', '2026-11:open']);
  });

  it('締めた月は、未処理の送金があれば unsettled、精算済みにすれば settled', async () => {
    const g = await setup(['alice', 'bob']);
    const { alice, bob } = g.people;
    await pay(g, alice, 10000);
    const october = await api.close(alice, g.groupId, '2026-10');
    assert.equal(october.status, 201);

    assert.deepEqual(statuses(await api.months(alice, g.groupId)), ['2026-10:unsettled', '2026-11:open']);

    assert.equal((await api.settle(bob, october.body.transfers[0].id)).status, 200);
    assert.deepEqual(statuses(await api.months(alice, g.groupId)), ['2026-10:settled', '2026-11:open']);
  });

  it('繰越した送金も処理済み（繰越先の月は未締めのまま）', async () => {
    const g = await setup(['alice', 'bob']);
    const { alice, bob } = g.people;
    await pay(g, alice, 10000);
    const october = await api.close(alice, g.groupId, '2026-10');
    assert.equal((await api.carry(bob, october.body.transfers[0].id)).status, 200);

    assert.deepEqual(statuses(await api.months(alice, g.groupId)), ['2026-10:settled', '2026-11:open']);
  });

  it('送金が0件の月は、締めた時点で settled', async () => {
    const g = await setup(['alice', 'bob']);
    const { alice, bob } = g.people;
    await pay(g, alice, 5000);
    await pay(g, bob, 5000);
    assert.equal((await api.close(alice, g.groupId, '2026-10')).status, 201);

    assert.deepEqual(statuses(await api.months(alice, g.groupId)), ['2026-10:settled', '2026-11:open']);
  });

  it('未処理の送金は、締めた月ごとに見る（前の月の精算済みと混ざらない）', async () => {
    const g = await setup(['alice', 'bob']);
    const { alice, bob } = g.people;
    await pay(g, alice, 10000);
    const october = await api.close(alice, g.groupId, '2026-10');
    assert.equal((await api.settle(bob, october.body.transfers[0].id)).status, 200);
    await pay(g, alice, 6000, '2026-11');
    assert.equal((await api.close(alice, g.groupId, '2026-11')).status, 201);

    assert.deepEqual(statuses(await api.months(alice, g.groupId)), [
      '2026-10:settled',
      '2026-11:unsettled',
      '2026-12:open',
    ]);
  });

  it('今月を締めていれば、翌月まで並ぶ。currentMonth は翌月にならない', async () => {
    const g = await setup(['alice', 'bob']);
    const { alice, bob } = g.people;
    await pay(g, alice, 10000);
    const october = await api.close(alice, g.groupId, '2026-10');
    assert.equal((await api.settle(bob, october.body.transfers[0].id)).status, 200);
    await pay(g, alice, 6000, '2026-11');
    assert.equal((await api.close(alice, g.groupId, '2026-11')).status, 201);

    const result = await api.months(alice, g.groupId);
    assert.equal(result.body.currentMonth, '2026-11');
    assert.equal(result.body.months.at(-1).month, '2026-12');
    assert.equal(result.body.months.at(-1).status, 'open');
  });

  it('月が替わると、今月を締めていなくても、新しい月まで並ぶ', async () => {
    const g = await setup(['alice', 'bob']);

    const result = await api.months(g.people.alice, g.groupId, { now: NOW_DECEMBER });
    assert.equal(result.body.currentMonth, '2026-12');
    assert.deepEqual(statuses(result), ['2026-10:open', '2026-11:open', '2026-12:open']);
  });

  it('締めずに飛ばした月は skipped', async () => {
    // 作成月（2026-10）に支出が無く、翌月に最初の支出を登録したグループは、2026-11を最初に締められる（4章）。
    const g = await setup(['alice', 'bob']);
    const { alice } = g.people;
    await pay(g, alice, 8000, '2026-11');
    assert.equal((await api.close(alice, g.groupId, '2026-11')).status, 201);

    assert.deepEqual(statuses(await api.months(alice, g.groupId)), ['2026-10:skipped', '2026-11:unsettled', '2026-12:open']);
  });

  it('途中から参加したメンバーには、参加した月より前の月は出ない', async () => {
    const g = await setup(['alice', 'bob', 'newbie'], { newbie: { historyFromMonth: '2026-11' } });
    const { alice, newbie } = g.people;
    await pay(g, alice, 10000);
    assert.equal((await api.close(alice, g.groupId, '2026-10')).status, 201);

    assert.deepEqual(statuses(await api.months(newbie, g.groupId)), ['2026-11:open']);
    assert.deepEqual(statuses(await api.months(alice, g.groupId)), ['2026-10:unsettled', '2026-11:open']);
  });

  it('脱退が確定したメンバー（leaving）も、グループの月を一覧できる', async () => {
    const g = await setup(['alice', 'carol'], { carol: { status: 'leaving', expenseEndMonth: '2026-11' } });

    const result = await api.months(g.people.carol, g.groupId);
    assert.equal(result.status, 200);
    assert.deepEqual(statuses(result), ['2026-10:open', '2026-11:open']);
  });

  it('グループが無い・メンバーでない・脱退済み・他のグループのIDは、区別せず404', async () => {
    const f = await factory();
    const missing = await api.months(f.alice, 'no-such-group');
    assert.equal(missing.status, 404);
    for (const who of [f.outsider, f.erin]) {
      const result = await api.months(who, f.groupId);
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, missing.body);
    }
    const otherGroup = await api.months(f.alice, f.other.groupId);
    assert.equal(otherGroup.status, 404);
    assert.deepEqual(otherGroup.body, missing.body);
  });

  it('セッションが無ければ401', async () => {
    const f = await factory();
    const result = await api.months(null, f.groupId);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'unauthorized' });
  });

  it('D1のクエリ数は、締めた月の数によらず、認証を含めて一定', async () => {
    const g = await setup(['alice', 'bob']);
    const { alice } = g.people;
    const count = async () => {
      const counting = countingEnv(env);
      const result = await api.months(alice, g.groupId, { env: counting.env });
      assert.equal(result.status, 200);
      return counting.counts;
    };

    const before = await count();
    await pay(g, alice, 10000);
    assert.equal((await api.close(alice, g.groupId, '2026-10')).status, 201);
    const after = await count();

    assert.deepEqual(after, before);
    // 認証・メンバーの権限・締めた月と最後に締めた月の読み込み（batch の2文）。
    assert.deepEqual(after.batchSizes, [2]);
  });

  describe('入口（index.ts）', () => {
    const call = async (method: string, path: string, token: string | null) =>
      read(await worker.fetch(request(method, path, token), env));

    it('GET /groups/:id/months が月の一覧に届く。GET以外は405', async () => {
      const g = await setup(['alice', 'bob']);
      const ok = await call('GET', `/groups/${g.groupId}/months`, g.people.alice.token);
      assert.equal(ok.status, 200);
      assert.ok(Array.isArray(ok.body.months));
      assert.equal((await call('POST', `/groups/${g.groupId}/months`, g.people.alice.token)).status, 405);
    });

    it('IDの形でないものは404', async () => {
      const g = await setup(['alice']);
      assert.equal((await call('GET', '/groups/not%20an%20id/months', g.people.alice.token)).status, 404);
    });
  });
});
