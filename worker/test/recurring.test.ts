/// <reference types="node" />
// 固定費のAPI（src/recurring.ts）の検査。規則は docs/backend-design.md 7章・9章「固定費API」、競合は8章。
// 毎月の自動登録（Cron）は recurringRun.test.ts。ローカルD1（miniflare）での検査なので、確かめるのはロジック。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import worker from '../src/index.ts';
import { MAX_RECURRING_EXPENSES_PER_GROUP } from '../src/limits.ts';
import { createFixtureFactory, insertRecurringRow, NOW, type Fixture, type Person } from './apiFixture.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';
import { interferingEnv, read, request } from './monthApi.ts';
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
      assert.equal((await worker.fetch(request('DELETE', `/recurring-expenses/${id}`, f.alice.token), env)).status, 405);
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

    it('再開するときは、保存してある負担の対象も、今使えるか見る（止まっていた間に抜けた人がいれば409）', async () => {
      const f = await createFixture();
      const id = await insertRecurringRow(db, {
        groupId: f.groupId,
        categoryId: f.categoryId,
        payerMemberId: f.alice.memberId,
        splitMethod: 'equal',
        pausedReason: 'manual',
        allocations: [[f.alice.memberId, null, null], [f.erin.memberId, null, null]],
      });
      const result = await api.update(f.alice, id, { paused: false });
      assert.deepEqual([result.status, result.body.error, result.body.memberId], [409, 'member_not_available', f.erin.memberId]);
      const fixed = await api.update(f.alice, id, { paused: false, split: { method: 'single', memberId: f.alice.memberId } });
      assert.equal(fixed.status, 200);
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
});
