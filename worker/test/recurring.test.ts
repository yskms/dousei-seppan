/// <reference types="node" />
// 固定費のAPI（src/recurring.ts）の検査。規則は docs/backend-design.md 7章・9章「固定費API」、競合は8章。
// 毎月の自動登録（Cron）は recurringRun.test.ts。ローカルD1（miniflare）での検査なので、確かめるのはロジック。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import worker from '../src/index.ts';
import { MAX_RECURRING_EXPENSES_PER_GROUP } from '../src/limits.ts';
import { createFixtureFactory, insertClosing, insertRecurringRow, NOW, type Fixture, type Person } from './apiFixture.ts';
import { groupsApi } from './groupsApi.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';
import { interferingEnv, NOW_DECEMBER, read, request } from './monthApi.ts';
import { recurringApi } from './recurringApi.ts';

describe('固定費のAPI', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let env: Env;
  let createFixture: ReturnType<typeof createFixtureFactory>;
  let api: ReturnType<typeof recurringApi>;

  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
    env = local.env;
    createFixture = createFixtureFactory(db);
    api = recurringApi(env);
  });
  after(async () => {
    await local.dispose();
  });

  /** 登録の本文（家賃。毎月25日。今月から。費目の割合で分ける）。 */
  const body = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
    description: '家賃',
    amountMinor: 80000,
    categoryId: f.categoryId,
    payerMemberId: f.alice.memberId,
    split: { method: 'category' },
    dayOfMonth: 25,
    startMonth: '2026-11',
    ...overrides,
  });
  const created = async (f: Fixture, overrides: Record<string, unknown> = {}, who: Person = f.alice) => {
    const result = await api.create(who, f.groupId, body(f, overrides));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.recurringExpense as { id: string };
  };
  const rowOf = (id: string) =>
    db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').bind(id).first<Record<string, unknown>>();
  const allocationsOf = async (id: string) =>
    (
      await db
        .prepare(
          'SELECT member_id, share_basis_points, amount_minor FROM recurring_expense_allocations WHERE recurring_expense_id = ? ORDER BY member_id',
        )
        .bind(id)
        .all<{ member_id: string; share_basis_points: number | null; amount_minor: number | null }>()
    ).results;
  const versionOf = async (groupId: string) =>
    (await db.prepare('SELECT data_version FROM expense_groups WHERE id = ?').bind(groupId).first<{ data_version: number }>())!
      .data_version;
  const bump = (groupId: string) => () =>
    db.prepare('UPDATE expense_groups SET data_version = data_version + 1 WHERE id = ?').bind(groupId).run();

  describe('認証と権限', () => {
    it('セッションが無ければ401', async () => {
      const f = await createFixture();
      const id = (await created(f)).id;
      assert.equal((await api.list(null, f.groupId)).status, 401);
      assert.equal((await api.create(null, f.groupId, body(f))).status, 401);
      assert.equal((await api.update(null, id, { paused: true })).status, 401);
    });

    it('メンバーでない人・脱退済みの人・他のグループのメンバーは404（IDの存在を教えない）', async () => {
      const f = await createFixture();
      const id = (await created(f)).id;
      for (const who of [f.outsider, f.erin, f.other.member]) {
        assert.equal((await api.list(who, f.groupId)).status, 404);
        assert.equal((await api.create(who, f.groupId, body(f))).status, 404);
        assert.equal((await api.update(who, id, { paused: true })).status, 404);
      }
      assert.equal((await api.update(f.alice, 'recurring-unknown', { paused: true })).status, 404);
    });

    it('脱退が確定したメンバーは、一覧は見られるが、登録も変更もできない（403）', async () => {
      const f = await createFixture();
      const id = (await created(f)).id;
      assert.equal((await api.list(f.carol, f.groupId)).status, 200);
      assert.equal((await api.create(f.carol, f.groupId, body(f))).status, 403);
      assert.equal((await api.update(f.carol, id, { paused: true })).status, 403);
      assert.equal((await rowOf(id))!.paused_at, null);
    });

    it('HTTPのルーティング: 一覧・登録・変更が入口から呼べる。メソッドが違えば405', async () => {
      const f = await createFixture();
      const post = await read(
        await worker.fetch(request('POST', `/groups/${f.groupId}/recurring-expenses`, f.alice.token, body(f)), env),
      );
      assert.equal(post.status, 201);
      const id = post.body.recurringExpense.id as string;
      const get = await read(await worker.fetch(request('GET', `/groups/${f.groupId}/recurring-expenses`, f.alice.token), env));
      assert.equal(get.status, 200);
      assert.equal(get.body.recurringExpenses.length, 1);
      const patch = await read(
        await worker.fetch(request('PATCH', `/recurring-expenses/${id}`, f.alice.token, { paused: true }), env),
      );
      assert.equal(patch.status, 200);
      assert.equal(patch.body.recurringExpense.pausedReason, 'manual');
      assert.equal((await worker.fetch(request('PUT', `/recurring-expenses/${id}`, f.alice.token), env)).status, 405);
      assert.equal((await worker.fetch(request('DELETE', `/recurring-expenses/${id}`, f.alice.token), env)).status, 204);
      assert.equal((await worker.fetch(request('PUT', `/groups/${f.groupId}/recurring-expenses`, f.alice.token), env)).status, 405);
    });
  });

  describe('登録', () => {
    it('費目の割合で分ける固定費を登録できる。応答の形と、保存される行（個別の負担設定は持たない）', async () => {
      const f = await createFixture();
      const before = await versionOf(f.groupId);
      const result = await api.create(f.alice, f.groupId, body(f, { endMonth: '2027-03', currencyCode: 'JPY' }));
      assert.equal(result.status, 201);
      assert.deepEqual(result.body.recurringExpense, {
        id: result.body.recurringExpense.id,
        description: '家賃',
        amountMinor: 80000,
        categoryId: f.categoryId,
        categoryArchived: false,
        payerMemberId: f.alice.memberId,
        split: { method: 'category' },
        dayOfMonth: 25,
        startMonth: '2026-11',
        endMonth: '2027-03',
        pausedAt: null,
        pausedReason: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const row = await rowOf(result.body.recurringExpense.id);
      assert.equal(row!.group_id, f.groupId);
      assert.equal(row!.split_method, 'category');
      assert.deepEqual(await allocationsOf(result.body.recurringExpense.id), []);
      assert.equal(await versionOf(f.groupId), before + 1);
    });

    it('内容は前後の空白を落とし、空なら null。無くてもよい', async () => {
      const f = await createFixture();
      const none = await api.create(f.alice, f.groupId, (({ description: _d, ...rest }) => rest)(body(f)));
      assert.equal(none.status, 201);
      assert.equal(none.body.recurringExpense.description, null);
      const blank = await api.create(f.alice, f.groupId, body(f, { description: '   ' }));
      assert.equal(blank.body.recurringExpense.description, null);
      const trimmed = await api.create(f.alice, f.groupId, body(f, { description: '  光熱費 ' }));
      assert.equal(trimmed.body.recurringExpense.description, '光熱費');
    });

    it('負担の指定ごとに、個別の負担設定が保存され、一覧で入力と同じ形で返る', async () => {
      const f = await createFixture();
      const a = f.alice.memberId;
      const b = f.bob.memberId;
      const cases: { split: unknown; rows: unknown[] }[] = [
        {
          split: { method: 'equal', memberIds: [b, a] },
          rows: [
            { member_id: a, share_basis_points: null, amount_minor: null },
            { member_id: b, share_basis_points: null, amount_minor: null },
          ],
        },
        {
          split: {
            method: 'ratio',
            shares: [
              { memberId: a, basisPoints: 7000 },
              { memberId: b, basisPoints: 3000 },
            ],
          },
          rows: [
            { member_id: a, share_basis_points: 7000, amount_minor: null },
            { member_id: b, share_basis_points: 3000, amount_minor: null },
          ],
        },
        {
          split: {
            method: 'fixed',
            amounts: [
              { memberId: a, amountMinor: 50000 },
              { memberId: b, amountMinor: 30000 },
            ],
          },
          rows: [
            { member_id: a, share_basis_points: null, amount_minor: 50000 },
            { member_id: b, share_basis_points: null, amount_minor: 30000 },
          ],
        },
        { split: { method: 'single', memberId: b }, rows: [{ member_id: b, share_basis_points: null, amount_minor: null }] },
      ];
      // 一覧の並びは (作った時刻, id)。同じ時刻だとIDの順になるので、時刻をずらして作る。
      for (const [index, { split, rows }] of cases.entries()) {
        const result = await api.create(f.alice, f.groupId, body(f, { split }), { now: NOW + index * 1000 });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.deepEqual(await allocationsOf(result.body.recurringExpense.id), rows);
      }
      const list = await api.list(f.alice, f.groupId);
      assert.deepEqual(
        list.body.recurringExpenses.map((item: { split: unknown }) => item.split),
        cases.map((item) => {
          const split = item.split as { method: string; memberIds?: string[] };
          // 均等割りの対象は、メンバーIDの昇順で返る。
          return split.method === 'equal' ? { method: 'equal', memberIds: [a, b] } : split;
        }),
      );
    });

    it('入力の不備は400で、直す項目を返す', async () => {
      const f = await createFixture();
      const cases: [string, Record<string, unknown>][] = [
        ['foo', { foo: 1 }],
        ['amountMinor', { amountMinor: 0 }],
        ['amountMinor', { amountMinor: 1.5 }],
        ['dayOfMonth', { dayOfMonth: 0 }],
        ['dayOfMonth', { dayOfMonth: 32 }],
        ['dayOfMonth', { dayOfMonth: 1.5 }],
        ['dayOfMonth', { dayOfMonth: '5' }],
        ['startMonth', { startMonth: '2026-13' }],
        ['startMonth', { startMonth: undefined }],
        ['endMonth', { endMonth: '2026-10' }],
        ['endMonth', { endMonth: 'x' }],
        ['description', { description: 'あ'.repeat(101) }],
        ['id', { id: 'not-a-uuid' }],
        ['id', { id: randomUUID().toUpperCase() }],
        ['split.method', { split: { method: 'unknown' } }],
        ['split.shares', { split: { method: 'ratio', shares: [{ memberId: f.alice.memberId, basisPoints: 5000 }] } }],
        ['currencyCode', { currencyCode: 'jpy' }],
        ['categoryId', { categoryId: 5 }],
        ['payerMemberId', { payerMemberId: '' }],
      ];
      for (const [field, overrides] of cases) {
        const result = await api.create(f.alice, f.groupId, body(f, overrides));
        assert.deepEqual([result.status, result.body.field], [400, field], JSON.stringify(overrides));
      }
      const empty = await api.create(f.alice, f.groupId, {});
      assert.equal(empty.status, 400);
      assert.equal(await versionOf(f.groupId), 0, '何も書かない');
    });

    it('費目: 他のグループの費目は400、アーカイブした費目は409', async () => {
      const f = await createFixture();
      const other = await api.create(f.alice, f.groupId, body(f, { categoryId: f.other.categoryId }));
      assert.deepEqual([other.status, other.body.field], [400, 'categoryId']);
      const archived = await api.create(f.alice, f.groupId, body(f, { categoryId: f.archivedCategoryId }));
      assert.deepEqual([archived.status, archived.body.error], [409, 'category_not_available']);
    });

    it('メンバー: グループに居ない人は400、使えない人は409（開始月に使えるかを見る）', async () => {
      const f = await createFixture();
      const otherMember = f.other.member.memberId;
      const foreignPayer = await api.create(f.alice, f.groupId, body(f, { payerMemberId: otherMember }));
      assert.deepEqual([foreignPayer.status, foreignPayer.body.field], [400, 'payerMemberId']);
      const foreignSplit = await api.create(f.alice, f.groupId, body(f, { split: { method: 'equal', memberIds: [f.alice.memberId, otherMember] } }));
      assert.deepEqual([foreignSplit.status, foreignSplit.body.field], [400, 'split.memberIds']);
      for (const memberId of [f.erin.memberId, f.daveMemberId]) {
        const payer = await api.create(f.alice, f.groupId, body(f, { payerMemberId: memberId }));
        assert.deepEqual([payer.status, payer.body.error, payer.body.memberId], [409, 'member_not_available', memberId]);
      }
      // carol は脱退月が2026-11。開始月が2026-12なら、使えない。2026-11なら使える。
      const late = await api.create(f.alice, f.groupId, body(f, { startMonth: '2026-12', split: { method: 'single', memberId: f.carol.memberId } }));
      assert.deepEqual([late.status, late.body.error, late.body.memberId], [409, 'member_not_available', f.carol.memberId]);
      const inMonth = await api.create(f.alice, f.groupId, body(f, { split: { method: 'single', memberId: f.carol.memberId } }));
      assert.equal(inMonth.status, 201);
      // 参加前の月は使えない。newbie は2026-11から。開始月が先なら使える。
      const ok = await api.create(f.alice, f.groupId, body(f, { startMonth: '2027-01', split: { method: 'single', memberId: f.newbie.memberId } }));
      assert.equal(ok.status, 201);
    });

    it('金額指定の合計が金額と合わなければ400（split.amounts）', async () => {
      const f = await createFixture();
      const split = {
        method: 'fixed',
        amounts: [
          { memberId: f.alice.memberId, amountMinor: 50000 },
          { memberId: f.bob.memberId, amountMinor: 20000 },
        ],
      };
      const result = await api.create(f.alice, f.groupId, body(f, { split }));
      assert.deepEqual([result.status, result.body.field], [400, 'split.amounts']);
    });

    it('通貨: グループの通貨と違えば409。同じなら登録できる', async () => {
      const f = await createFixture();
      const mismatch = await api.create(f.alice, f.groupId, body(f, { currencyCode: 'USD' }));
      assert.deepEqual([mismatch.status, mismatch.body.error, mismatch.body.currencyCode], [409, 'currency_mismatch', 'JPY']);
      assert.equal((await api.create(f.alice, f.groupId, body(f, { currencyCode: 'JPY' }))).status, 201);
    });

    it('同じidの再送は、新しく作らず、保存済みの固定費を200で返す（バージョンも上げない）', async () => {
      const f = await createFixture();
      const id = randomUUID();
      const first = await api.create(f.alice, f.groupId, body(f, { id }));
      assert.equal(first.status, 201);
      const version = await versionOf(f.groupId);
      // 内容は見比べない（最初の登録のあとに変えられていれば、変えたあとの状態）。
      await api.update(f.bob, id, { amountMinor: 90000 });
      const again = await api.create(f.alice, f.groupId, body(f, { id, amountMinor: 1 }));
      assert.equal(again.status, 200);
      assert.equal(again.body.recurringExpense.amountMinor, 90000);
      assert.equal(await versionOf(f.groupId), version + 1, '再送では上がらない（上がったのは、変更の分だけ）');
      const count = await db.prepare('SELECT count(*) AS n FROM recurring_expenses WHERE id = ?').bind(id).first<{ n: number }>();
      assert.equal(count!.n, 1);
    });

    it('再送の200にも thisMonthSkipped を返す（今月の「作らなかった」記録から導く）。月が変われば false', async () => {
      const f = await createFixture();
      // NOW は 2026-11-19。毎月5日は今月の予定日を過ぎていて、25日はまだ。
      const late = randomUUID();
      const first = await api.create(f.alice, f.groupId, body(f, { id: late, dayOfMonth: 5 }));
      assert.deepEqual([first.status, first.body.thisMonthSkipped], [201, true]);
      const again = await api.create(f.alice, f.groupId, body(f, { id: late, dayOfMonth: 5 }));
      assert.deepEqual([again.status, again.body.thisMonthSkipped], [200, true]);
      assert.equal(again.body.recurringExpense.id, late);
      const nextMonth = await api.create(f.alice, f.groupId, body(f, { id: late, dayOfMonth: 5 }), { now: NOW_DECEMBER });
      assert.deepEqual([nextMonth.status, nextMonth.body.thisMonthSkipped], [200, false], '12月には、12月の記録は無い');

      const early = randomUUID();
      const firstEarly = await api.create(f.alice, f.groupId, body(f, { id: early, dayOfMonth: 25 }));
      assert.deepEqual([firstEarly.status, firstEarly.body.thisMonthSkipped], [201, false]);
      const resent = await api.create(f.alice, f.groupId, body(f, { id: early, dayOfMonth: 25 }));
      assert.deepEqual([resent.status, resent.body.thisMonthSkipped], [200, false]);
    });

    it('他のグループが使っているidは、中身を返さず409', async () => {
      const f = await createFixture();
      const id = randomUUID();
      assert.equal((await api.create(f.alice, f.groupId, body(f, { id }))).status, 201);
      const other = await api.create(f.other.member, f.other.groupId, {
        ...body(f, { id }),
        categoryId: f.other.categoryId,
        payerMemberId: f.other.member.memberId,
      });
      assert.deepEqual([other.status, other.body], [409, { error: 'conflict' }]);
    });

    it(`1つのグループの固定費は${MAX_RECURRING_EXPENSES_PER_GROUP}まで（終了・停止したものを含む）`, async () => {
      const f = await createFixture();
      for (let i = 0; i < MAX_RECURRING_EXPENSES_PER_GROUP; i++) {
        await insertRecurringRow(db, {
          groupId: f.groupId,
          categoryId: f.categoryId,
          payerMemberId: f.alice.memberId,
          ...(i % 2 === 0 ? { endMonth: '2026-10' } : { pausedReason: 'manual' as const }),
        });
      }
      const result = await api.create(f.alice, f.groupId, body(f));
      assert.deepEqual([result.status, result.body.error], [409, 'too_many_recurring_expenses']);
      // 他のグループには影響しない。
      const other = await api.create(f.other.member, f.other.groupId, {
        ...body(f),
        categoryId: f.other.categoryId,
        payerMemberId: f.other.member.memberId,
      });
      assert.equal(other.status, 201);
    });

    it('読んだあとに他の書き込みが入ったら、読み直して1回だけやり直す。続けば409', async () => {
      const f = await createFixture();
      const once = await api.create(f.alice, f.groupId, body(f), { env: interferingEnv(env, bump(f.groupId)) });
      assert.equal(once.status, 201);
      const twice = await api.create(f.alice, f.groupId, body(f), { env: interferingEnv(env, bump(f.groupId), { times: 2 }) });
      assert.deepEqual([twice.status, twice.body.error], [409, 'conflict']);
      const count = await db.prepare('SELECT count(*) AS n FROM recurring_expenses WHERE group_id = ?').bind(f.groupId).first<{ n: number }>();
      assert.equal(count!.n, 1, '負けた登録は何も書いていない');
    });
  });

  describe('一覧', () => {
    it('登録の古い順に、止めたもの・終了したものも含めて返す。アーカイブした費目は categoryArchived', async () => {
      const f = await createFixture();
      // 並びは (作った時刻, id)。時刻が同じだとIDの順になるので、時刻をずらして作る。
      const first = await api.create(f.alice, f.groupId, body(f, { description: '家賃' }), { now: NOW + 1000 });
      const second = await api.create(f.alice, f.groupId, body(f, { description: '回線', endMonth: '2026-12' }), { now: NOW + 2000 });
      await api.update(f.alice, second.body.recurringExpense.id, { paused: true });
      // 直接書いた行の作った時刻は NOW（いちばん古い）。
      const third = await insertRecurringRow(db, {
        groupId: f.groupId,
        categoryId: f.archivedCategoryId,
        payerMemberId: f.bob.memberId,
        description: '昔の費目',
      });
      const list = await api.list(f.bob, f.groupId);
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.body.recurringExpenses.map((item: { id: string }) => item.id),
        [third, first.body.recurringExpense.id, second.body.recurringExpense.id],
      );
      const [c, a, b] = list.body.recurringExpenses;
      assert.deepEqual([a.pausedAt, a.pausedReason, a.categoryArchived], [null, null, false]);
      assert.deepEqual([b.pausedAt, b.pausedReason, b.endMonth], [NOW, 'manual', '2026-12']);
      assert.deepEqual([c.categoryArchived, c.description], [true, '昔の費目']);
    });

    it('他のグループの固定費は入らない。固定費が無ければ空', async () => {
      const f = await createFixture();
      assert.deepEqual((await api.list(f.alice, f.groupId)).body, { recurringExpenses: [] });
      await created(f);
      assert.deepEqual((await api.list(f.other.member, f.other.groupId)).body, { recurringExpenses: [] });
    });
  });

  describe('変更', () => {
    it('送った項目だけを変える。内容と終了月は null で消せる', async () => {
      const f = await createFixture();
      const { id } = await created(f, { endMonth: '2027-03' });
      const version = await versionOf(f.groupId);
      const result = await api.update(
        f.bob,
        id,
        { amountMinor: 85000, dayOfMonth: 31, startMonth: '2026-12', description: null, endMonth: null },
        { now: NOW + 5000 },
      );
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body.recurringExpense, {
        id,
        description: null,
        amountMinor: 85000,
        categoryId: f.categoryId,
        categoryArchived: false,
        payerMemberId: f.alice.memberId,
        split: { method: 'category' },
        dayOfMonth: 31,
        startMonth: '2026-12',
        endMonth: null,
        pausedAt: null,
        pausedReason: null,
        createdAt: NOW,
        updatedAt: NOW + 5000,
      });
      const row = await rowOf(id);
      assert.deepEqual([row!.amount_minor, row!.day_of_month, row!.start_month, row!.end_month, row!.description], [85000, 31, '2026-12', null, null]);
      assert.equal(await versionOf(f.groupId), version + 1);
      // 一覧にも反映されている。
      assert.deepEqual((await api.list(f.alice, f.groupId)).body.recurringExpenses[0], result.body.recurringExpense);
    });

    it('入力の不備は400。空の本文は項目を返さない。知らない・他のグループの固定費は404', async () => {
      const f = await createFixture();
      const { id } = await created(f, { startMonth: '2026-11', endMonth: '2026-12' });
      const cases: [string, Record<string, unknown>][] = [
        ['id', { id: randomUUID() }],
        ['dayOfMonth', { dayOfMonth: 32 }],
        ['paused', { paused: 'yes' }],
        ['amountMinor', { amountMinor: -1 }],
        ['endMonth', { startMonth: '2027-01', endMonth: '2026-12' }],
        ['currencyCode', { currencyCode: 'jp' }],
      ];
      for (const [field, patch] of cases) {
        const result = await api.update(f.alice, id, patch);
        assert.deepEqual([result.status, result.body.field], [400, field], JSON.stringify(patch));
      }
      const empty = await api.update(f.alice, id, {});
      assert.deepEqual([empty.status, empty.body], [400, { error: 'invalid_request' }]);
      assert.equal((await api.update(f.other.member, id, { paused: true })).status, 404);
    });

    it('片方の月だけを送ったときは、保存してある相手と前後を比べる（400）', async () => {
      const f = await createFixture();
      const { id } = await created(f, { startMonth: '2026-11', endMonth: '2026-12' });
      const end = await api.update(f.alice, id, { endMonth: '2026-10' });
      assert.deepEqual([end.status, end.body.field], [400, 'endMonth']);
      const start = await api.update(f.alice, id, { startMonth: '2027-01' });
      assert.deepEqual([start.status, start.body.field], [400, 'startMonth']);
      assert.equal((await api.update(f.alice, id, { endMonth: '2026-11' })).status, 200, '開始月と同じ月は終われる');
    });

    it('金額指定の固定費は、金額を変えるとき、負担の指定も送り直す。割合・均等・単独は、そのまま変えられる', async () => {
      const f = await createFixture();
      const a = f.alice.memberId;
      const b = f.bob.memberId;
      const fixed = await created(f, {
        split: {
          method: 'fixed',
          amounts: [
            { memberId: a, amountMinor: 50000 },
            { memberId: b, amountMinor: 30000 },
          ],
        },
      });
      const without = await api.update(f.alice, fixed.id, { amountMinor: 90000 });
      assert.deepEqual([without.status, without.body.field], [400, 'split']);
      const mismatch = await api.update(f.alice, fixed.id, {
        amountMinor: 90000,
        split: { method: 'fixed', amounts: [{ memberId: a, amountMinor: 60000 }, { memberId: b, amountMinor: 20000 }] },
      });
      assert.deepEqual([mismatch.status, mismatch.body.field], [400, 'split.amounts']);
      const ok = await api.update(f.alice, fixed.id, {
        amountMinor: 90000,
        split: { method: 'fixed', amounts: [{ memberId: a, amountMinor: 60000 }, { memberId: b, amountMinor: 30000 }] },
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(await allocationsOf(fixed.id), [
        { member_id: a, share_basis_points: null, amount_minor: 60000 },
        { member_id: b, share_basis_points: null, amount_minor: 30000 },
      ]);

      const ratio = await created(f, { split: { method: 'ratio', shares: [{ memberId: a, basisPoints: 6000 }, { memberId: b, basisPoints: 4000 }] } });
      assert.equal((await api.update(f.alice, ratio.id, { amountMinor: 12345 })).status, 200);
      assert.deepEqual((await allocationsOf(ratio.id)).map((row) => row.share_basis_points), [6000, 4000]);
    });

    it('負担の指定を送ると、個別の負担設定を丸ごと置き換える。費目の割合に戻すと、行を消す', async () => {
      const f = await createFixture();
      const a = f.alice.memberId;
      const b = f.bob.memberId;
      const { id } = await created(f, { split: { method: 'equal', memberIds: [a, b] } });
      const ratio = await api.update(f.alice, id, { split: { method: 'ratio', shares: [{ memberId: a, basisPoints: 2500 }, { memberId: b, basisPoints: 7500 }] } });
      assert.equal(ratio.status, 200);
      assert.deepEqual(ratio.body.recurringExpense.split, { method: 'ratio', shares: [{ memberId: a, basisPoints: 2500 }, { memberId: b, basisPoints: 7500 }] });
      assert.deepEqual(await allocationsOf(id), [
        { member_id: a, share_basis_points: 2500, amount_minor: null },
        { member_id: b, share_basis_points: 7500, amount_minor: null },
      ]);
      const single = await api.update(f.alice, id, { split: { method: 'single', memberId: b } });
      assert.deepEqual(await allocationsOf(id), [{ member_id: b, share_basis_points: null, amount_minor: null }]);
      assert.equal((await rowOf(id))!.split_method, 'single');
      assert.deepEqual(single.body.recurringExpense.split, { method: 'single', memberId: b });
      const category = await api.update(f.alice, id, { split: { method: 'category' } });
      assert.deepEqual(category.body.recurringExpense.split, { method: 'category' });
      assert.deepEqual(await allocationsOf(id), []);
      assert.equal((await api.update(f.alice, id, { split: { method: 'category' } })).status, 200, '費目の割合のまま送り直しても通る');
    });

    it('費目を変える: 他のグループの費目は400、アーカイブした費目は409。アーカイブした費目のままでも、ほかは直せる', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      const other = await api.update(f.alice, id, { categoryId: f.other.categoryId });
      assert.deepEqual([other.status, other.body.field], [400, 'categoryId']);
      const archived = await api.update(f.alice, id, { categoryId: f.archivedCategoryId });
      assert.deepEqual([archived.status, archived.body.error], [409, 'category_not_available']);
      const fresh = await createFixture.addCategory(f.groupId, 'fresh');
      const changed = await api.update(f.alice, id, { categoryId: fresh });
      assert.equal(changed.status, 200);
      assert.equal(changed.body.recurringExpense.categoryId, fresh);

      // すでにアーカイブした費目の固定費は、費目を変えないかぎり、内容を直せる。
      const stale = await insertRecurringRow(db, { groupId: f.groupId, categoryId: f.archivedCategoryId, payerMemberId: f.alice.memberId });
      const edited = await api.update(f.alice, stale, { description: '直した' });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.recurringExpense.categoryArchived, true);
    });

    it('支払者を変える: 使えない人・他のグループの人は断る。変えなければ、使えない人のままでも他は直せる', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      const left = await api.update(f.alice, id, { payerMemberId: f.erin.memberId });
      assert.deepEqual([left.status, left.body.error, left.body.memberId], [409, 'member_not_available', f.erin.memberId]);
      const foreign = await api.update(f.alice, id, { payerMemberId: f.other.member.memberId });
      assert.deepEqual([foreign.status, foreign.body.field], [400, 'payerMemberId']);
      const bob = await api.update(f.alice, id, { payerMemberId: f.bob.memberId });
      assert.equal(bob.body.recurringExpense.payerMemberId, f.bob.memberId);

      const gone = await insertRecurringRow(db, { groupId: f.groupId, categoryId: f.categoryId, payerMemberId: f.erin.memberId, pausedReason: 'payer_left' });
      assert.equal((await api.update(f.alice, gone, { description: '付け替え待ち' })).status, 200);
      const fixedPayer = await api.update(f.alice, gone, { payerMemberId: f.bob.memberId });
      assert.equal(fixedPayer.status, 200);
      assert.equal(fixedPayer.body.recurringExpense.pausedReason, 'payer_left', '付け替えただけでは再開しない');
    });

    it('通貨: 違えば409', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      const result = await api.update(f.alice, id, { amountMinor: 1, currencyCode: 'USD' });
      assert.deepEqual([result.status, result.body.error, result.body.currencyCode], [409, 'currency_mismatch', 'JPY']);
      assert.equal((await rowOf(id))!.amount_minor, 80000);
    });

    it('読んだあとに他の書き込みが入ったら、読み直して1回だけやり直す。続けば409で、何も変えない', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      const once = await api.update(f.alice, id, { amountMinor: 1000 }, { env: interferingEnv(env, bump(f.groupId)) });
      assert.equal(once.status, 200);
      const twice = await api.update(f.alice, id, { amountMinor: 2000 }, { env: interferingEnv(env, bump(f.groupId), { times: 2 }) });
      assert.deepEqual([twice.status, twice.body.error], [409, 'conflict']);
      assert.equal((await rowOf(id))!.amount_minor, 1000);
    });
  });

  describe('止める・再開する', () => {
    it('止めると `manual` で止まる。止まっているものを止めても、時刻も理由も変わらない', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      const stopped = await api.update(f.bob, id, { paused: true });
      assert.deepEqual([stopped.body.recurringExpense.pausedAt, stopped.body.recurringExpense.pausedReason], [NOW, 'manual']);
      const again = await api.update(f.alice, id, { paused: true }, { now: NOW + 60_000 });
      assert.deepEqual([again.body.recurringExpense.pausedAt, again.body.recurringExpense.pausedReason], [NOW, 'manual']);
      const reason = await insertRecurringRow(db, { groupId: f.groupId, categoryId: f.categoryId, payerMemberId: f.alice.memberId, pausedReason: 'member_changed' });
      const kept = await api.update(f.alice, reason, { paused: true });
      assert.equal(kept.body.recurringExpense.pausedReason, 'member_changed', '理由を上書きしない');
    });

    it('手動で止めたものは、そのまま再開できる。止まっていないものの再開は何もしない', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      await api.update(f.alice, id, { paused: true });
      const resumed = await api.update(f.alice, id, { paused: false });
      assert.equal(resumed.status, 200);
      assert.deepEqual([resumed.body.recurringExpense.pausedAt, resumed.body.recurringExpense.pausedReason], [null, null]);
      const row = await rowOf(id);
      assert.deepEqual([row!.paused_at, row!.paused_reason], [null, null]);
      assert.equal((await api.update(f.alice, id, { paused: false })).status, 200);
    });

    it('支払者が脱退して止まったものは、使える人に付け替えて再開する。同じ人のままでは再開できない', async () => {
      const f = await createFixture();
      const id = await insertRecurringRow(db, { groupId: f.groupId, categoryId: f.categoryId, payerMemberId: f.erin.memberId, pausedReason: 'payer_left' });
      const same = await api.update(f.alice, id, { paused: false });
      assert.deepEqual([same.status, same.body.error, same.body.memberId], [409, 'member_not_available', f.erin.memberId]);
      assert.equal((await rowOf(id))!.paused_reason, 'payer_left');
      const moved = await api.update(f.alice, id, { paused: false, payerMemberId: f.bob.memberId });
      assert.equal(moved.status, 200);
      assert.deepEqual([moved.body.recurringExpense.payerMemberId, moved.body.recurringExpense.pausedAt], [f.bob.memberId, null]);
    });

    it('メンバーが変わって止まったものは、負担の指定を送り直さないと再開できない', async () => {
      const f = await createFixture();
      const a = f.alice.memberId;
      const b = f.bob.memberId;
      const id = await insertRecurringRow(db, {
        groupId: f.groupId,
        categoryId: f.categoryId,
        payerMemberId: a,
        splitMethod: 'equal',
        pausedReason: 'member_changed',
        allocations: [[a, null, null], [b, null, null]],
      });
      const without = await api.update(f.alice, id, { paused: false });
      assert.deepEqual([without.status, without.body.field], [400, 'split']);
      assert.equal((await rowOf(id))!.paused_reason, 'member_changed');
      const resumed = await api.update(f.alice, id, { paused: false, split: { method: 'equal', memberIds: [a, b, f.newbie.memberId] } });
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      assert.equal(resumed.body.recurringExpense.pausedAt, null);
      assert.equal((await allocationsOf(id)).length, 3);
    });

    it('`category` 以外の負担の固定費は、止めた理由によらず、負担の指定を送り直さないと再開できない（止まっていた間にメンバーが変わっても、理由は変わらないため）', async () => {
      const f = await createFixture();
      const a = f.alice.memberId;
      const b = f.bob.memberId;
      for (const pausedReason of ['manual', 'payer_left', 'member_changed'] as const) {
        const id = await insertRecurringRow(db, {
          groupId: f.groupId,
          categoryId: f.categoryId,
          payerMemberId: a,
          splitMethod: 'ratio',
          pausedReason,
          allocations: [[a, 5000, null], [b, 5000, null]],
        });
        const without = await api.update(f.alice, id, { paused: false });
        assert.deepEqual([without.status, without.body.field], [400, 'split'], pausedReason);
        assert.equal((await rowOf(id))!.paused_reason, pausedReason, '再開されていない');
        // 止めている間に新しい人が増えても、送り直した負担の指定で、全員を確かめてから再開する。
        const resumed = await api.update(f.alice, id, {
          paused: false,
          split: { method: 'ratio', shares: [{ memberId: a, basisPoints: 4000 }, { memberId: b, basisPoints: 4000 }, { memberId: f.newbie.memberId, basisPoints: 2000 }] },
        });
        assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
        assert.equal(resumed.body.recurringExpense.pausedAt, null);
      }
    });

    it('再開するときは、送り直した負担の対象も、支払者も、今使えるか見る（止まっていた間に抜けた人がいれば409）', async () => {
      const f = await createFixture();
      const base = { groupId: f.groupId, categoryId: f.categoryId, payerMemberId: f.alice.memberId, splitMethod: 'equal' as const, pausedReason: 'manual' as const };
      const id = await insertRecurringRow(db, { ...base, allocations: [[f.alice.memberId, null, null], [f.erin.memberId, null, null]] });
      const stale = await api.update(f.alice, id, { paused: false, split: { method: 'equal', memberIds: [f.alice.memberId, f.erin.memberId] } });
      assert.deepEqual([stale.status, stale.body.error, stale.body.memberId], [409, 'member_not_available', f.erin.memberId]);
      const ok = await api.update(f.alice, id, { paused: false, split: { method: 'single', memberId: f.alice.memberId } });
      assert.equal(ok.status, 200);
      // 費目の割合の固定費は、負担の指定が無いので、支払者だけ見る。
      const gone = await insertRecurringRow(db, { ...base, splitMethod: 'category', payerMemberId: f.erin.memberId });
      const payer = await api.update(f.alice, gone, { paused: false });
      assert.deepEqual([payer.status, payer.body.error, payer.body.memberId], [409, 'member_not_available', f.erin.memberId]);
    });

    it('アーカイブした費目の固定費は、再開を断る（費目を選び直してもらう）', async () => {
      const f = await createFixture();
      const id = await insertRecurringRow(db, { groupId: f.groupId, categoryId: f.archivedCategoryId, payerMemberId: f.alice.memberId, pausedReason: 'manual' });
      const result = await api.update(f.alice, id, { paused: false });
      assert.deepEqual([result.status, result.body.error], [409, 'category_not_available']);
      const moved = await api.update(f.alice, id, { paused: false, categoryId: f.categoryId });
      assert.equal(moved.status, 200);
      assert.equal(moved.body.recurringExpense.categoryArchived, false);
    });
  });

  describe('削除（一度も支出を作っていない固定費だけ。作らなかった記録は数えない）', () => {
    // 生成記録。`expenseId` が null は「今月の分は作らなかった」記録、あれば支出を作った記録（支出を消しても残る）。
    const runRow = (groupId: string, recurringId: string, expenseId: string | null = 'expense-made', month = '2026-10') =>
      db
        .prepare('INSERT INTO recurring_expense_runs (group_id, recurring_expense_id, scheduled_month, expense_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(groupId, recurringId, month, expenseId, NOW)
        .run();
    const runsOf = async (recurringId: string) =>
      (
        await db
          .prepare('SELECT scheduled_month, expense_id FROM recurring_expense_runs WHERE recurring_expense_id = ? ORDER BY scheduled_month')
          .bind(recurringId)
          .all<{ scheduled_month: string; expense_id: string | null }>()
      ).results;
    const del = (who: Person | null, id: string, options: { env?: Env } = {}) => api.remove(who, id, options);

    it('一度も支出を作っていない固定費は消せる。負担設定も消え、一覧から無くなり、バージョンが上がる', async () => {
      const f = await createFixture();
      const keep = await created(f, { description: '残す' });
      const { id } = await created(f, { split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] } });
      const version = await versionOf(f.groupId);
      const result = await del(f.bob, id);
      assert.deepEqual([result.status, result.body], [204, null]);
      assert.equal(await rowOf(id), null);
      assert.deepEqual(await allocationsOf(id), []);
      assert.equal(await versionOf(f.groupId), version + 1);
      assert.deepEqual(
        (await api.list(f.alice, f.groupId)).body.recurringExpenses.map((item: { id: string }) => item.id),
        [keep.id],
      );
      assert.equal((await del(f.alice, id)).status, 404, '消したものは、もう無い');
    });

    it('消すと、上限の件数と、通貨のロックから外れる（間違えて作ったものが残り続けない）', async () => {
      const f = await createFixture();
      const groups = groupsApi(env);
      assert.equal((await groups.getGroup(f.alice, f.groupId)).body.group.currencyLocked, false);
      const { id } = await created(f);
      assert.equal((await groups.getGroup(f.alice, f.groupId)).body.group.currencyLocked, true, '固定費があると、通貨は変えられない');
      assert.equal((await del(f.alice, id)).status, 204);
      assert.equal((await groups.getGroup(f.alice, f.groupId)).body.group.currencyLocked, false);
    });

    it('一度でも支出を作った（支出を作った生成記録がある）固定費は消せない（409）。止める・終了月は使える', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      await runRow(f.groupId, id);
      const result = await del(f.alice, id);
      assert.deepEqual([result.status, result.body], [409, { error: 'recurring_expense_in_use' }]);
      assert.notEqual(await rowOf(id), null);
      assert.equal((await api.update(f.alice, id, { paused: true, endMonth: '2026-12' })).status, 200);
    });

    it('作った支出を消しても、生成記録は残るので、固定費は消せない（作り直さない記録と同じ根拠）', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      await runRow(f.groupId, id, 'expense-deleted-by-user'); // 支出の行は無い（消された）。expense_id は外部キーではない
      assert.equal((await del(f.alice, id)).status, 409);
      assert.deepEqual(await runsOf(id), [{ scheduled_month: '2026-10', expense_id: 'expense-deleted-by-user' }]);
    });

    it('予定日を過ぎてから登録した固定費（今月の分は作らなかった記録がある）は消せる。記録も一緒に消え、通貨のロックも外れる', async () => {
      const f = await createFixture();
      const groups = groupsApi(env);
      // NOW は 2026-11-19。毎月5日は、今月の予定日をすでに過ぎている。
      const result = await api.create(f.alice, f.groupId, body(f, { dayOfMonth: 5, split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] } }));
      assert.equal(result.body.thisMonthSkipped, true);
      const id = result.body.recurringExpense.id;
      assert.deepEqual(await runsOf(id), [{ scheduled_month: '2026-11', expense_id: null }]);
      assert.equal((await groups.getGroup(f.alice, f.groupId)).body.group.currencyLocked, true);

      const version = await versionOf(f.groupId);
      assert.equal((await del(f.bob, id)).status, 204);
      assert.equal(await rowOf(id), null);
      assert.deepEqual(await runsOf(id), []);
      assert.deepEqual(await allocationsOf(id), []);
      assert.equal(await versionOf(f.groupId), version + 1);
      assert.equal((await groups.getGroup(f.alice, f.groupId)).body.group.currencyLocked, false);
    });

    it('作らなかった記録と、支出を作った記録の両方があれば、消せない。何も消えない', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      await runRow(f.groupId, id, null, '2026-10');
      await runRow(f.groupId, id, 'expense-made', '2026-11');
      assert.equal((await del(f.alice, id)).status, 409);
      assert.notEqual(await rowOf(id), null);
      assert.equal((await runsOf(id)).length, 2);
    });

    it('消す間際に自動登録が作ったら、読み直して判定し直し、消さずに409', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      // 読んだあとに、自動登録が生成記録を作った（バージョンも上がる）状況。
      const cron = async () => {
        await runRow(f.groupId, id);
        await bump(f.groupId)();
      };
      const result = await del(f.alice, id, { env: interferingEnv(env, cron) });
      assert.deepEqual([result.status, result.body.error], [409, 'recurring_expense_in_use']);
      assert.notEqual(await rowOf(id), null);
    });

    it('権限: 脱退が確定したメンバーは403、メンバーでない人・他のグループは404、セッションが無ければ401。何も消えない', async () => {
      const f = await createFixture();
      const { id } = await created(f);
      assert.equal((await del(null, id)).status, 401);
      assert.equal((await del(f.carol, id)).status, 403);
      for (const who of [f.outsider, f.erin, f.other.member]) assert.equal((await del(who, id)).status, 404);
      assert.equal((await del(f.alice, 'recurring-unknown')).status, 404);
      assert.notEqual(await rowOf(id), null);
    });
  });

  describe('今月の分（登録・再開の直後に、手で入力した分と二重にならない）', () => {
    // NOW は 2026-11-19。毎月5日の固定費は、今月の予定日をすでに過ぎている。25日は、まだ。
    const skipRows = async (id: string) =>
      (
        await db
          .prepare('SELECT scheduled_month, expense_id FROM recurring_expense_runs WHERE recurring_expense_id = ?')
          .bind(id)
          .all<{ scheduled_month: string; expense_id: string | null }>()
      ).results;

    it('予定日を過ぎた状態で登録したら、今月の分は作らない記録を残す（来月から）。応答の thisMonthSkipped で知らせる', async () => {
      const f = await createFixture();
      const result = await api.create(f.alice, f.groupId, body(f, { dayOfMonth: 5 }));
      assert.equal(result.status, 201);
      assert.equal(result.body.thisMonthSkipped, true);
      assert.deepEqual(await skipRows(result.body.recurringExpense.id), [{ scheduled_month: '2026-11', expense_id: null }]);
    });

    it('予定日がまだなら、記録しない。開始月が来月以降でも、記録しない。終了月が先月でも、記録しない', async () => {
      const f = await createFixture();
      for (const overrides of [{ dayOfMonth: 25 }, { dayOfMonth: 5, startMonth: '2026-12' }, { dayOfMonth: 5, startMonth: '2026-10', endMonth: '2026-10' }]) {
        const result = await api.create(f.alice, f.groupId, body(f, overrides));
        assert.equal(result.status, 201, JSON.stringify(overrides));
        assert.equal(result.body.thisMonthSkipped, false, JSON.stringify(overrides));
        assert.deepEqual(await skipRows(result.body.recurringExpense.id), [], JSON.stringify(overrides));
      }
    });

    it('再開・日の変更・開始月の変更で、新しく今月の予定日を過ぎた状態にしたら、今月の分は作らない記録を残す', async () => {
      const f = await createFixture();
      const resume = await created(f, { dayOfMonth: 25 });
      await api.update(f.alice, resume.id, { paused: true });
      await api.update(f.alice, resume.id, { dayOfMonth: 5 }); // 止まっているので、まだ記録しない
      assert.deepEqual(await skipRows(resume.id), []);
      const resumed = await api.update(f.alice, resume.id, { paused: false });
      assert.equal(resumed.body.thisMonthSkipped, true);
      assert.deepEqual(await skipRows(resume.id), [{ scheduled_month: '2026-11', expense_id: null }]);

      const moved = await created(f, { dayOfMonth: 25 });
      const day = await api.update(f.alice, moved.id, { dayOfMonth: 10 });
      assert.equal(day.body.thisMonthSkipped, true);
      assert.equal((await skipRows(moved.id)).length, 1);

      const later = await created(f, { dayOfMonth: 5, startMonth: '2027-01' });
      assert.equal((await api.update(f.alice, later.id, { startMonth: '2026-11' })).body.thisMonthSkipped, true);
    });

    it('もともと作る時期に来ていた固定費（Cronがまだ作っていないだけ）の変更では、記録しない（作る分を取り上げない）', async () => {
      const f = await createFixture();
      const id = await insertRecurringRow(db, { groupId: f.groupId, categoryId: f.categoryId, payerMemberId: f.alice.memberId, dayOfMonth: 5 });
      const edited = await api.update(f.alice, id, { description: '直した', amountMinor: 70000 });
      assert.equal(edited.body.thisMonthSkipped, false);
      assert.deepEqual(await skipRows(id), []);
    });

    it('アーカイブした費目の固定費の費目を選び直しても、記録しない（見送られていた今月の分は、次の自動登録が作る。費目を戻したときと同じ）', async () => {
      const f = await createFixture();
      const id = await insertRecurringRow(db, { groupId: f.groupId, categoryId: f.archivedCategoryId, payerMemberId: f.alice.memberId, dayOfMonth: 5 });
      const fresh = await createFixture.addCategory(f.groupId, 'fresh');
      const changed = await api.update(f.alice, id, { categoryId: fresh });
      assert.deepEqual([changed.status, changed.body.thisMonthSkipped], [200, false]);
      assert.deepEqual(await skipRows(id), []);
    });

    it('今月の分をすでに作っている固定費は、止めて再開しても、記録を重ねない（一意制約に落ちない）', async () => {
      const f = await createFixture();
      const id = await insertRecurringRow(db, { groupId: f.groupId, categoryId: f.categoryId, payerMemberId: f.alice.memberId, dayOfMonth: 5 });
      await db
        .prepare('INSERT INTO recurring_expense_runs (group_id, recurring_expense_id, scheduled_month, expense_id, created_at) VALUES (?, ?, ?, NULL, ?)')
        .bind(f.groupId, id, '2026-11', NOW)
        .run();
      await api.update(f.alice, id, { paused: true });
      const resumed = await api.update(f.alice, id, { paused: false });
      assert.deepEqual([resumed.status, resumed.body.thisMonthSkipped], [200, false]);
      assert.equal((await skipRows(id)).length, 1);
    });
  });

  describe('支払者・負担の対象を見る月は、自動登録と同じ（最初に支出を作る月）', () => {
    it('今月を早めに締めていれば、翌月で見る: 今月で脱退する人を支払者にした登録は、翌月に使えないので断る', async () => {
      const f = await createFixture(); // carol は脱退月が2026-11
      const open = await api.create(f.alice, f.groupId, body(f, { payerMemberId: f.carol.memberId }));
      assert.equal(open.status, 201, '今月が未締めなら、今月に作るので使える');

      const closed = await createFixture();
      await insertClosing(db, closed.groupId, '2026-11', closed.alice.memberId);
      const result = await api.create(closed.alice, closed.groupId, body(closed, { payerMemberId: closed.carol.memberId }));
      assert.deepEqual([result.status, result.body.error, result.body.memberId], [409, 'member_not_available', closed.carol.memberId]);
      const split = await api.create(closed.alice, closed.groupId, body(closed, { split: { method: 'single', memberId: closed.carol.memberId } }));
      assert.deepEqual([split.status, split.body.error], [409, 'member_not_available']);
      // 再開も同じ月で見る。
      const paused = await insertRecurringRow(db, { groupId: closed.groupId, categoryId: closed.categoryId, payerMemberId: closed.carol.memberId, pausedReason: 'manual' });
      const resumed = await api.update(closed.alice, paused, { paused: false });
      assert.deepEqual([resumed.status, resumed.body.error], [409, 'member_not_available']);
    });
  });
});
