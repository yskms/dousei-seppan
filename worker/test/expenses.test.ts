/// <reference types="node" />
// 支出のAPI（src/expenses.ts）の検査。規則は docs/backend-design.md 3章・5章・8章、形は9章「支出API」。
// ローカルD1（miniflare）での検査なので、確かめるのはロジック。並行して走ったときの性質は、
// 競合を「読んだあとに別の書き込みが入った」状況で再現して確かめている（本番D1での確認は13章の9）。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  handleCreateExpense,
  handleDeleteExpense,
  handleListExpenses,
  handleUpdateExpense,
} from '../src/expenses.ts';
import worker from '../src/index.ts';
import { createFixtureFactory, insertClosing, NOW, type Fixture, type Person } from './apiFixture.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';

interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

describe('支出のAPI', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let env: Env;
  let createFixture: () => Promise<Fixture>;

  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
    env = local.env;
    createFixture = createFixtureFactory(db);
  });
  after(async () => {
    await local.dispose();
  });

  // --- 呼び出しの道具 ---------------------------------------------------------------------------

  const request = (method: string, path: string, token: string | null, body?: unknown) =>
    new Request(`https://example.test${path}`, {
      method,
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const read = async (response: Response): Promise<ApiResult> => {
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };

  const create = async (f: Fixture, who: Person | null, body: unknown, options: { now?: number; env?: Env; groupId?: string } = {}) =>
    read(
      await handleCreateExpense(
        request('POST', `/groups/${options.groupId ?? f.groupId}/expenses`, who?.token ?? null, body),
        options.env ?? env,
        options.now ?? NOW,
        options.groupId ?? f.groupId,
      ),
    );
  const update = async (who: Person | null, expenseId: string, body: unknown, options: { now?: number; env?: Env } = {}) =>
    read(
      await handleUpdateExpense(
        request('PATCH', `/expenses/${expenseId}`, who?.token ?? null, body),
        options.env ?? env,
        options.now ?? NOW,
        expenseId,
      ),
    );
  const remove = async (who: Person | null, expenseId: string, options: { now?: number; env?: Env } = {}) =>
    read(
      await handleDeleteExpense(
        request('DELETE', `/expenses/${expenseId}`, who?.token ?? null),
        options.env ?? env,
        options.now ?? NOW,
        expenseId,
      ),
    );
  const list = async (f: Fixture, who: Person | null, month: string | null, groupId = f.groupId) =>
    read(
      await handleListExpenses(
        request('GET', `/groups/${groupId}/expenses${month === null ? '' : `?month=${month}`}`, who?.token ?? null),
        env,
        NOW,
        groupId,
      ),
    );

  /** 正常な登録の本文（カテゴリの割合で分ける、11月分）。 */
  const body = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
    expenseDate: '2026-11-19',
    targetMonth: '2026-11',
    description: 'スーパー',
    amountMinor: 4280,
    categoryId: f.categoryId,
    payerMemberId: f.alice.memberId,
    split: { method: 'category' },
    ...overrides,
  });
  /** 登録して、支出のIDを返す。 */
  const register = async (f: Fixture, overrides: Record<string, unknown> = {}, who: Person = f.alice) => {
    const result = await create(f, who, body(f, overrides));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.expense.id as string;
  };

  // --- DBの状態の確認 ---------------------------------------------------------------------------

  const dataVersion = async (groupId: string) =>
    (await db.prepare('SELECT data_version FROM expense_groups WHERE id = ?').bind(groupId).first<{ data_version: number }>())!
      .data_version;
  const expenseCount = async (groupId: string) =>
    (await db.prepare('SELECT count(*) AS n FROM expenses WHERE group_id = ?').bind(groupId).first<{ n: number }>())!.n;
  const expenseRow = (expenseId: string) =>
    db.prepare('SELECT * FROM expenses WHERE id = ?').bind(expenseId).first<Record<string, unknown>>();
  const allocationRows = async (expenseId: string) =>
    (
      await db
        .prepare(
          'SELECT member_id, burden_minor, share_basis_points FROM expense_allocations WHERE expense_id = ? ORDER BY member_id',
        )
        .bind(expenseId)
        .all<{ member_id: string; burden_minor: number; share_basis_points: number | null }>()
    ).results;

  // === 登録 ====================================================================================

  describe('登録（POST /groups/:id/expenses）', () => {
    it('カテゴリの割合で分ける支出は、負担額を保存せずに登録できる', async () => {
      const f = await createFixture();
      const before = await dataVersion(f.groupId);
      const result = await create(f, f.alice, body(f));

      assert.equal(result.status, 201);
      const expense = result.body.expense;
      assert.deepEqual(
        { ...expense, id: undefined },
        {
          id: undefined,
          expenseDate: '2026-11-19',
          targetMonth: '2026-11',
          description: 'スーパー',
          amountMinor: 4280,
          categoryId: f.categoryId,
          payerMemberId: f.alice.memberId,
          createdByMemberId: f.alice.memberId,
          recurringExpenseId: null,
          splitMethod: 'category',
          allocations: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      );
      const row = await expenseRow(expense.id);
      assert.equal(row!.amount_minor, 4280);
      assert.equal(row!.split_method, 'category');
      assert.deepEqual(await allocationRows(expense.id), []);
      assert.equal(await dataVersion(f.groupId), before + 1);
    });

    it('他のメンバーの支払を代わりに登録できる（支払者と登録者が別）', async () => {
      const f = await createFixture();
      const result = await create(f, f.alice, body(f, { payerMemberId: f.bob.memberId }));
      assert.equal(result.status, 201);
      assert.equal(result.body.expense.payerMemberId, f.bob.memberId);
      assert.equal(result.body.expense.createdByMemberId, f.alice.memberId);
    });

    it('内容は任意。空なら null で保存する', async () => {
      const f = await createFixture();
      const { description: _omitted, ...withoutDescription } = body(f);
      const omitted = await create(f, f.alice, withoutDescription);
      assert.equal(omitted.status, 201);
      assert.equal(omitted.body.expense.description, null);
      const blank = await create(f, f.alice, body(f, { description: '  ' }));
      assert.equal(blank.body.expense.description, null);
      assert.equal((await expenseRow(blank.body.expense.id))!.description, null);
    });

    it('均等割り: 端数は固定のメンバー順に1単位ずつ配る（10,000円を3人で 3,334・3,333・3,333）', async () => {
      const f = await createFixture();
      const id = await register(f, {
        amountMinor: 10000,
        split: { method: 'equal', memberIds: [f.carol.memberId, f.alice.memberId, f.bob.memberId] },
      });
      assert.deepEqual(await allocationRows(id), [
        { member_id: f.alice.memberId, burden_minor: 3334, share_basis_points: null },
        { member_id: f.bob.memberId, burden_minor: 3333, share_basis_points: null },
        { member_id: f.carol.memberId, burden_minor: 3333, share_basis_points: null },
      ]);
      assert.equal((await expenseRow(id))!.split_method, 'equal');
    });

    it('割合割り: 割合を残し、端数を配って合計を金額と一致させる', async () => {
      const f = await createFixture();
      const id = await register(f, {
        amountMinor: 10001,
        split: {
          method: 'ratio',
          shares: [
            { memberId: f.bob.memberId, basisPoints: 4000 },
            { memberId: f.alice.memberId, basisPoints: 6000 },
          ],
        },
      });
      assert.deepEqual(await allocationRows(id), [
        { member_id: f.alice.memberId, burden_minor: 6001, share_basis_points: 6000 },
        { member_id: f.bob.memberId, burden_minor: 4000, share_basis_points: 4000 },
      ]);
    });

    it('割合割り: 0%のメンバーには端数を配らない', async () => {
      const f = await createFixture();
      const id = await register(f, {
        amountMinor: 1,
        split: {
          method: 'ratio',
          shares: [
            { memberId: f.alice.memberId, basisPoints: 0 },
            { memberId: f.bob.memberId, basisPoints: 10000 },
          ],
        },
      });
      assert.deepEqual(await allocationRows(id), [
        { member_id: f.alice.memberId, burden_minor: 0, share_basis_points: 0 },
        { member_id: f.bob.memberId, burden_minor: 1, share_basis_points: 10000 },
      ]);
    });

    it('金額指定: 指定額をそのまま保存する', async () => {
      const f = await createFixture();
      const id = await register(f, {
        split: {
          method: 'fixed',
          amounts: [
            { memberId: f.alice.memberId, amountMinor: 3000 },
            { memberId: f.bob.memberId, amountMinor: 1280 },
          ],
        },
      });
      assert.deepEqual(await allocationRows(id), [
        { member_id: f.alice.memberId, burden_minor: 3000, share_basis_points: null },
        { member_id: f.bob.memberId, burden_minor: 1280, share_basis_points: null },
      ]);
    });

    it('1人が全額負担: 支払者と負担者が別でもよい', async () => {
      const f = await createFixture();
      const id = await register(f, { split: { method: 'single', memberId: f.bob.memberId } });
      assert.deepEqual(await allocationRows(id), [
        { member_id: f.bob.memberId, burden_minor: 4280, share_basis_points: null },
      ]);
    });

    it('金額指定の合計が金額と合わなければ断る（差額は自動で配分しない）。何も書かれず、バージョンも上がらない', async () => {
      const f = await createFixture();
      const before = await dataVersion(f.groupId);
      for (const total of [4279, 4281]) {
        const result = await create(
          f,
          f.alice,
          body(f, {
            split: {
              method: 'fixed',
              amounts: [
                { memberId: f.alice.memberId, amountMinor: total - 1000 },
                { memberId: f.bob.memberId, amountMinor: 1000 },
              ],
            },
          }),
        );
        assert.equal(result.status, 400);
        assert.deepEqual(result.body, { error: 'invalid_request', field: 'split.amounts' });
      }
      assert.equal(await expenseCount(f.groupId), 0);
      assert.equal(await dataVersion(f.groupId), before);
    });

    it('入力の形が違えば400で、直す項目を返す', async () => {
      const f = await createFixture();
      const cases: [Record<string, unknown>, string][] = [
        [{ amountMinor: 0 }, 'amountMinor'],
        [{ amountMinor: 1.5 }, 'amountMinor'],
        [{ amountMinor: 1_000_000_000_001 }, 'amountMinor'],
        [{ expenseDate: '2026-02-30' }, 'expenseDate'],
        [{ targetMonth: '2026-11-01' }, 'targetMonth'],
        [{ description: 'あ'.repeat(101) }, 'description'],
        [{ split: { method: 'ratio', shares: [{ memberId: f.alice.memberId, basisPoints: 9999 }] } }, 'split.shares'],
        [{ surprise: true }, 'surprise'],
      ];
      for (const [overrides, field] of cases) {
        const result = await create(f, f.alice, body(f, overrides));
        assert.equal(result.status, 400, field);
        assert.deepEqual(result.body, { error: 'invalid_request', field });
      }
      assert.equal(await expenseCount(f.groupId), 0);
    });

    it('JSONでない本文・大きすぎる本文を断る', async () => {
      const f = await createFixture();
      const notJson = await handleCreateExpense(
        new Request(`https://example.test/groups/${f.groupId}/expenses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${f.alice.token}` },
          body: 'not json',
        }),
        env,
        NOW,
        f.groupId,
      );
      assert.equal(notJson.status, 400);
      const tooLarge = await handleCreateExpense(
        new Request(`https://example.test/groups/${f.groupId}/expenses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${f.alice.token}` },
          body: JSON.stringify({ description: 'x'.repeat(20_000) }),
        }),
        env,
        NOW,
        f.groupId,
      );
      assert.equal(tooLarge.status, 413);
    });

    it('他のグループの費目・メンバーを指定すると400（IDを知っていても使えない）', async () => {
      const f = await createFixture();
      const foreignCategory = await create(f, f.alice, body(f, { categoryId: f.other.categoryId }));
      assert.deepEqual(foreignCategory, { status: 400, body: { error: 'invalid_request', field: 'categoryId' } });
      const foreignPayer = await create(f, f.alice, body(f, { payerMemberId: f.other.member.memberId }));
      assert.deepEqual(foreignPayer, { status: 400, body: { error: 'invalid_request', field: 'payerMemberId' } });
      const foreign = f.other.member.memberId;
      const foreignSplits: [Record<string, unknown>, string][] = [
        [{ method: 'single', memberId: foreign }, 'split.memberId'],
        [{ method: 'equal', memberIds: [f.alice.memberId, foreign] }, 'split.memberIds'],
        [
          {
            method: 'ratio',
            shares: [
              { memberId: f.alice.memberId, basisPoints: 5000 },
              { memberId: foreign, basisPoints: 5000 },
            ],
          },
          'split.shares',
        ],
        [
          {
            method: 'fixed',
            amounts: [
              { memberId: f.alice.memberId, amountMinor: 4000 },
              { memberId: foreign, amountMinor: 280 },
            ],
          },
          'split.amounts',
        ],
      ];
      for (const [split, field] of foreignSplits) {
        const result = await create(f, f.alice, body(f, { split }));
        assert.deepEqual(result, { status: 400, body: { error: 'invalid_request', field } });
      }
      assert.equal(await expenseCount(f.groupId), 0);
    });

    it('アーカイブした費目では、新しい支出を登録できない', async () => {
      const f = await createFixture();
      const result = await create(f, f.alice, body(f, { categoryId: f.archivedCategoryId }));
      assert.deepEqual(result, { status: 409, body: { error: 'category_not_available' } });
    });

    describe('支払者・負担の対象にできるメンバー（5章）', () => {
      it('削除したユーザーは選べない（支払者にも、負担の対象にも）', async () => {
        const f = await createFixture();
        const asPayer = await create(f, f.alice, body(f, { payerMemberId: f.daveMemberId }));
        assert.deepEqual(asPayer, { status: 409, body: { error: 'member_not_available', memberId: f.daveMemberId } });
        const asTarget = await create(
          f,
          f.alice,
          body(f, { split: { method: 'equal', memberIds: [f.alice.memberId, f.daveMemberId] } }),
        );
        assert.deepEqual(asTarget, { status: 409, body: { error: 'member_not_available', memberId: f.daveMemberId } });
      });

      it('脱退済みのメンバーは選べない', async () => {
        const f = await createFixture();
        const result = await create(f, f.alice, body(f, { payerMemberId: f.erin.memberId }));
        assert.equal(result.status, 409);
        assert.equal(result.body.error, 'member_not_available');
      });

      it('脱退が確定したメンバーは、脱退月までは選べ、翌月以降は選べない', async () => {
        const f = await createFixture();
        // 脱退月は 2026-11。11月分には選べる。
        assert.equal((await create(f, f.alice, body(f, { payerMemberId: f.carol.memberId }))).status, 201);
        // 11月を早めに締めると、12月分にしか登録できず、脱退月を過ぎているので選べない。
        await insertClosing(db, f.groupId, '2026-10', f.alice.memberId);
        await insertClosing(db, f.groupId, '2026-11', f.alice.memberId);
        const afterEnd = await create(f, f.alice, body(f, { targetMonth: '2026-12', payerMemberId: f.carol.memberId }));
        assert.deepEqual(afterEnd, { status: 409, body: { error: 'member_not_available', memberId: f.carol.memberId } });
      });

      it('脱退を選んだ月（leave_requested_month）が終わったら、Cronの確定を待たずに、翌月の支払者・負担の対象に選べない', async () => {
        const f = await createFixture();
        // bob は 2026-10 で脱退する予定。いまは 2026-11 で、Cronはまだ確定していない（status は active のまま）。
        await db.prepare(`UPDATE group_members SET leave_requested_month = '2026-10' WHERE id = ?`).bind(f.bob.memberId).run();
        const asPayer = await create(f, f.alice, body(f, { targetMonth: '2026-11', payerMemberId: f.bob.memberId }));
        assert.deepEqual(asPayer, { status: 409, body: { error: 'member_not_available', memberId: f.bob.memberId } });
        const asTarget = await create(
          f,
          f.alice,
          body(f, { targetMonth: '2026-11', split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] } }),
        );
        assert.deepEqual(asTarget, { status: 409, body: { error: 'member_not_available', memberId: f.bob.memberId } });
        // 脱退月（10月）の支出には、まだ選べる。
        assert.equal((await create(f, f.alice, body(f, { targetMonth: '2026-10', payerMemberId: f.bob.memberId }))).status, 201);
        // 脱退月が今月なら、今月分には選べる。
        await db.prepare(`UPDATE group_members SET leave_requested_month = '2026-11' WHERE id = ?`).bind(f.bob.memberId).run();
        assert.equal((await create(f, f.alice, body(f, { targetMonth: '2026-11', payerMemberId: f.bob.memberId }))).status, 201);
      });

      it('参加する前の月の支出には選べない', async () => {
        const f = await createFixture();
        // newbie は 2026-11 から。10月分（未締めで登録できる）の支払者にはできない。
        const result = await create(f, f.alice, body(f, { targetMonth: '2026-10', payerMemberId: f.newbie.memberId }));
        assert.deepEqual(result, { status: 409, body: { error: 'member_not_available', memberId: f.newbie.memberId } });
        assert.equal((await create(f, f.alice, body(f, { payerMemberId: f.newbie.memberId }))).status, 201);
      });
    });

    describe('登録できる月（8章「支出の対象月」）', () => {
      it('まだ締めていなければ、作成月（2026-10）から今月（2026-11）まで', async () => {
        const f = await createFixture();
        assert.equal((await create(f, f.alice, body(f, { targetMonth: '2026-10' }))).status, 201);
        assert.equal((await create(f, f.alice, body(f, { targetMonth: '2026-11' }))).status, 201);
        for (const targetMonth of ['2026-09', '2026-12', '2027-11']) {
          const result = await create(f, f.alice, body(f, { targetMonth }));
          assert.deepEqual(result, { status: 409, body: { error: 'month_not_registerable', from: '2026-10', to: '2026-11' } });
        }
        assert.equal(await expenseCount(f.groupId), 2);
      });

      it('前の月を締めた後は、今月だけ。締め済みの月には登録できない', async () => {
        const f = await createFixture();
        await insertClosing(db, f.groupId, '2026-10', f.alice.memberId);
        assert.equal((await create(f, f.alice, body(f, { targetMonth: '2026-11' }))).status, 201);
        const closed = await create(f, f.alice, body(f, { targetMonth: '2026-10' }));
        assert.deepEqual(closed, { status: 409, body: { error: 'month_not_registerable', from: '2026-11', to: '2026-11' } });
      });

      it('今月を早めに締めた後は、翌月だけ。同じ暦月の日付の支出を翌月分として登録できる', async () => {
        const f = await createFixture();
        await insertClosing(db, f.groupId, '2026-10', f.alice.memberId);
        await insertClosing(db, f.groupId, '2026-11', f.alice.memberId);
        const sameMonthDate = await create(f, f.alice, body(f, { expenseDate: '2026-11-25', targetMonth: '2026-12' }));
        assert.equal(sameMonthDate.status, 201);
        assert.equal(sameMonthDate.body.expense.expenseDate, '2026-11-25');
        assert.equal(sameMonthDate.body.expense.targetMonth, '2026-12');
        const closed = await create(f, f.alice, body(f));
        assert.deepEqual(closed, { status: 409, body: { error: 'month_not_registerable', from: '2026-12', to: '2026-12' } });
        // 2か月以上先も登録できない。
        assert.equal((await create(f, f.alice, body(f, { targetMonth: '2027-01' }))).status, 409);
      });

      it('「今月」は、グループのタイムゾーンで決める（UTCでは11月でも、東京では12月）', async () => {
        const f = await createFixture();
        const jstDecember = Date.UTC(2026, 10, 30, 16, 0, 0); // 東京は 12/1 01:00
        assert.equal((await create(f, f.alice, body(f, { targetMonth: '2026-12' }), { now: jstDecember })).status, 201);
        const beforeMidnight = Date.UTC(2026, 10, 30, 14, 59, 59); // 東京は 11/30 23:59:59
        assert.equal((await create(f, f.alice, body(f, { targetMonth: '2026-12' }), { now: beforeMidnight })).status, 409);
      });

      it('新しいメンバーは、参加した月より前には登録できない', async () => {
        const f = await createFixture();
        const result = await create(f, f.newbie, body(f, { targetMonth: '2026-10', payerMemberId: f.alice.memberId }));
        assert.deepEqual(result, { status: 409, body: { error: 'month_not_registerable', from: '2026-11', to: '2026-11' } });
        assert.equal(
          (await create(f, f.newbie, body(f, { targetMonth: '2026-11', payerMemberId: f.newbie.memberId }))).status,
          201,
        );
      });
    });

    describe('認証と権限', () => {
      it('セッションが無い・無効なら401。何も書かれない', async () => {
        const f = await createFixture();
        assert.deepEqual(await create(f, null, body(f)), { status: 401, body: { error: 'unauthorized' } });
        const forged = { ...f.alice, token: 'A'.repeat(43) };
        assert.equal((await create(f, forged, body(f))).status, 401);
        assert.equal(await expenseCount(f.groupId), 0);
      });

      it('グループのメンバーでない人は404（グループがあることも教えない）。何も書かれない', async () => {
        const f = await createFixture();
        const before = await dataVersion(f.groupId);
        assert.deepEqual(await create(f, f.outsider, body(f)), { status: 404, body: { error: 'not_found' } });
        // 別のグループのメンバーが、このグループのIDで呼んでも同じ。
        assert.deepEqual(await create(f, f.other.member, body(f)), { status: 404, body: { error: 'not_found' } });
        // 存在しないグループも同じ応答。
        assert.deepEqual(await create(f, f.alice, body(f), { groupId: 'no-such-group' }), {
          status: 404,
          body: { error: 'not_found' },
        });
        assert.equal(await expenseCount(f.groupId), 0);
        assert.equal(await dataVersion(f.groupId), before);
      });

      it('脱退済み・削除したユーザーも404', async () => {
        const f = await createFixture();
        assert.equal((await create(f, f.erin, body(f))).status, 404);
      });

      it('脱退が確定したメンバー（leaving）は、支出を記録できない（403）', async () => {
        const f = await createFixture();
        const result = await create(f, f.carol, body(f, { payerMemberId: f.alice.memberId }));
        assert.deepEqual(result, { status: 403, body: { error: 'forbidden' } });
        assert.equal(await expenseCount(f.groupId), 0);
      });

      it('脱退を選んだ月が終わったメンバーも、Cronの確定を待たずに、支出を記録できない（403）。脱退月のうちは記録できる', async () => {
        const f = await createFixture();
        const id = await register(f);
        await db.prepare(`UPDATE group_members SET leave_requested_month = '2026-10' WHERE id = ?`).bind(f.bob.memberId).run();
        const before = await dataVersion(f.groupId);
        assert.deepEqual(await create(f, f.bob, body(f)), { status: 403, body: { error: 'forbidden' } });
        assert.deepEqual(await update(f.bob, id, { amountMinor: 1 }), { status: 403, body: { error: 'forbidden' } });
        assert.deepEqual(await remove(f.bob, id), { status: 403, body: { error: 'forbidden' } });
        assert.equal(await dataVersion(f.groupId), before);
        assert.equal((await expenseRow(id))!.amount_minor, 4280);
        // グループのデータは、見られる。
        assert.equal((await list(f, f.bob, '2026-11')).status, 200);
        // 脱退月が今月のうちは、これまでどおり記録できる。
        await db.prepare(`UPDATE group_members SET leave_requested_month = '2026-11' WHERE id = ?`).bind(f.bob.memberId).run();
        assert.equal((await create(f, f.bob, body(f))).status, 201);
      });
    });

    describe('競合（8章）', () => {
      /**
       * 書き込み（batch）の直前に、`interference` を `times` 回だけ実行するDB。
       * 「検証のために読んだあと、書く前に、別のリクエストが書いた」状況を作る。
       */
      const interferingDb = (interference: () => Promise<unknown>, times: number): Env => {
        let left = times;
        const proxy = new Proxy(db, {
          get(target, property) {
            if (property === 'batch') {
              return async (statements: D1PreparedStatement[]) => {
                if (left > 0) {
                  left -= 1;
                  await interference();
                }
                return target.batch(statements);
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return { ...env, DB: proxy };
      };
      const bump = (groupId: string) =>
        db.prepare('UPDATE expense_groups SET data_version = data_version + 1 WHERE id = ?').bind(groupId).run();

      it('1回だけ競合したら、読み直してやり直し、登録できる', async () => {
        const f = await createFixture();
        const before = await dataVersion(f.groupId);
        const result = await create(f, f.alice, body(f), { env: interferingDb(() => bump(f.groupId), 1) });
        assert.equal(result.status, 201);
        assert.equal(await expenseCount(f.groupId), 1);
        assert.equal(await dataVersion(f.groupId), before + 2); // 別のリクエストの1回と、この登録
      });

      it('やり直しても競合したら、409（conflict）で、何も書かれない', async () => {
        const f = await createFixture();
        const before = await dataVersion(f.groupId);
        const result = await create(f, f.alice, body(f), { env: interferingDb(() => bump(f.groupId), 2) });
        assert.deepEqual(result, { status: 409, body: { error: 'conflict' } });
        assert.equal(await expenseCount(f.groupId), 0);
        assert.equal(await dataVersion(f.groupId), before + 2); // 別のリクエストの2回分だけ
      });

      it('検証のあとに月が締められたら、書かれず、やり直した検証で「登録できない月」として断られる', async () => {
        const f = await createFixture();
        await insertClosing(db, f.groupId, '2026-10', f.alice.memberId);
        // 11月分を登録しようとして検証を通ったあと、書く前に別のメンバーが11月を締めた。
        const result = await create(f, f.alice, body(f, { targetMonth: '2026-11' }), {
          env: interferingDb(() => insertClosing(db, f.groupId, '2026-11', f.bob.memberId), 1),
        });
        assert.deepEqual(result, { status: 409, body: { error: 'month_not_registerable', from: '2026-12', to: '2026-12' } });
        assert.equal(await expenseCount(f.groupId), 0);
      });

      it('競合が続けば、負担額つきの登録も、支出も負担額も書かれない', async () => {
        const f = await createFixture();
        const result = await create(
          f,
          f.alice,
          body(f, { amountMinor: 1000, split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] } }),
          { env: interferingDb(() => bump(f.groupId), 2) },
        );
        assert.deepEqual(result, { status: 409, body: { error: 'conflict' } });
        assert.equal(await expenseCount(f.groupId), 0);
        const allocations = await db
          .prepare('SELECT count(*) AS n FROM expense_allocations WHERE group_id = ?')
          .bind(f.groupId)
          .first<{ n: number }>();
        assert.equal(allocations!.n, 0);
      });

      it('競合が続けば、削除も何も消さない（支出も負担額も残る）', async () => {
        const f = await createFixture();
        const id = await register(f, {
          amountMinor: 1000,
          split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
        });
        const result = await remove(f.alice, id, { env: interferingDb(() => bump(f.groupId), 2) });
        assert.deepEqual(result, { status: 409, body: { error: 'conflict' } });
        assert.notEqual(await expenseRow(id), null);
        assert.equal((await allocationRows(id)).length, 2);
        // 1回の競合なら、やり直して消せる。
        assert.equal((await remove(f.alice, id, { env: interferingDb(() => bump(f.groupId), 1) })).status, 204);
        assert.equal(await expenseRow(id), null);
        assert.deepEqual(await allocationRows(id), []);
      });

      it('競合が続けば、編集で負担額を置き換えることもしない（古い負担額が残る）', async () => {
        const f = await createFixture();
        const id = await register(f, {
          amountMinor: 1000,
          split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
        });
        const before = await allocationRows(id);
        const result = await update(
          f.alice,
          id,
          // 既存の負担額（alice・bob）と主キーが重ならない相手にする。重なると、守りが無くても一意制約違反で
          // 取り消され、守りの検査にならない。
          { amountMinor: 3000, split: { method: 'single', memberId: f.carol.memberId } },
          { env: interferingDb(() => bump(f.groupId), 2) },
        );
        assert.deepEqual(result, { status: 409, body: { error: 'conflict' } });
        assert.deepEqual(await allocationRows(id), before);
        assert.equal((await expenseRow(id))!.amount_minor, 1000);
        assert.equal((await expenseRow(id))!.split_method, 'equal');
      });

      it('検証のあとに月が締められたら、編集・削除も書かれない', async () => {
        const f = await createFixture();
        const editId = await register(f);
        const deleteId = await register(f);
        const edit = await update(f.alice, editId, { amountMinor: 1 }, {
          env: interferingDb(async () => {
            await insertClosing(db, f.groupId, '2026-10', f.bob.memberId);
            await insertClosing(db, f.groupId, '2026-11', f.bob.memberId);
          }, 1),
        });
        assert.deepEqual(edit, { status: 409, body: { error: 'month_closed' } });
        assert.equal((await expenseRow(editId))!.amount_minor, 4280);
        assert.equal((await remove(f.alice, deleteId)).status, 409);
        assert.notEqual(await expenseRow(deleteId), null);
      });
    });
  });

  // === 編集 ====================================================================================

  describe('編集（PATCH /expenses/:id）', () => {
    it('送った項目だけを変える。金額・内容・日付・カテゴリ・支払者を変えられる', async () => {
      const f = await createFixture();
      const id = await register(f);
      const otherCategory = await db
        .prepare(`INSERT INTO categories (id, group_id, name, icon, color, created_at) VALUES (?, ?, 'daily', 'cart', 'blue', 1)`)
        .bind(`category-daily-${id}`, f.groupId)
        .run()
        .then(() => `category-daily-${id}`);
      const before = await dataVersion(f.groupId);

      const later = NOW + 60_000;
      const result = await update(
        f.bob,
        id,
        {
          amountMinor: 5000,
          description: '日用品',
          expenseDate: '2026-11-18',
          categoryId: otherCategory,
          payerMemberId: f.bob.memberId,
        },
        { now: later },
      );

      assert.equal(result.status, 200);
      assert.deepEqual(result.body.expense, {
        id,
        expenseDate: '2026-11-18',
        targetMonth: '2026-11',
        description: '日用品',
        amountMinor: 5000,
        categoryId: otherCategory,
        payerMemberId: f.bob.memberId,
        createdByMemberId: f.alice.memberId, // 登録した人のまま
        recurringExpenseId: null,
        splitMethod: 'category',
        allocations: [],
        createdAt: NOW,
        updatedAt: later,
      });
      const row = await expenseRow(id);
      assert.equal(row!.amount_minor, 5000);
      assert.equal(row!.updated_at, later);
      assert.equal(await dataVersion(f.groupId), before + 1);
    });

    it('内容は null で消せる。送らなければ変わらない', async () => {
      const f = await createFixture();
      const id = await register(f);
      assert.equal((await update(f.alice, id, { amountMinor: 100 })).body.expense.description, 'スーパー');
      assert.equal((await update(f.alice, id, { description: null })).body.expense.description, null);
      assert.equal((await expenseRow(id))!.description, null);
    });

    it('カテゴリの割合 → 均等割りに変えると、負担額が作られる。カテゴリの割合に戻すと、消える', async () => {
      const f = await createFixture();
      const id = await register(f, { amountMinor: 1000 });
      const toEqual = await update(f.alice, id, {
        split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
      });
      assert.equal(toEqual.status, 200);
      assert.equal(toEqual.body.expense.splitMethod, 'equal');
      assert.deepEqual(toEqual.body.expense.allocations, [
        { memberId: f.alice.memberId, burdenMinor: 500, shareBasisPoints: null },
        { memberId: f.bob.memberId, burdenMinor: 500, shareBasisPoints: null },
      ]);
      assert.equal((await allocationRows(id)).length, 2);

      const back = await update(f.alice, id, { split: { method: 'category' } });
      assert.equal(back.status, 200);
      assert.deepEqual(back.body.expense.allocations, []);
      assert.deepEqual(await allocationRows(id), []);
      assert.equal((await expenseRow(id))!.split_method, 'category');
    });

    it('負担の指定を置き換えると、古い負担額は残らない（割合割り → 1人が全額）', async () => {
      const f = await createFixture();
      const id = await register(f, {
        amountMinor: 1000,
        split: {
          method: 'ratio',
          shares: [
            { memberId: f.alice.memberId, basisPoints: 7000 },
            { memberId: f.bob.memberId, basisPoints: 3000 },
          ],
        },
      });
      await update(f.alice, id, { split: { method: 'single', memberId: f.bob.memberId } });
      assert.deepEqual(await allocationRows(id), [
        { member_id: f.bob.memberId, burden_minor: 1000, share_basis_points: null },
      ]);
    });

    it('個別設定の支出の金額を変えるときは、負担の指定も要る。無ければ400で、何も変わらない', async () => {
      const f = await createFixture();
      const id = await register(f, {
        amountMinor: 1000,
        split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
      });
      const before = await dataVersion(f.groupId);
      assert.deepEqual(await update(f.alice, id, { amountMinor: 2000 }), {
        status: 400,
        body: { error: 'invalid_request', field: 'split' },
      });
      assert.equal((await expenseRow(id))!.amount_minor, 1000);
      assert.equal(await dataVersion(f.groupId), before);

      const withSplit = await update(f.alice, id, {
        amountMinor: 2001,
        split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
      });
      assert.equal(withSplit.status, 200);
      assert.deepEqual(
        (await allocationRows(id)).map((row) => row.burden_minor),
        [1001, 1000],
      );
    });

    it('金額が変わらなければ、個別設定の負担額は保存したまま変えない', async () => {
      const f = await createFixture();
      const id = await register(f, {
        amountMinor: 10001,
        split: {
          method: 'ratio',
          shares: [
            { memberId: f.alice.memberId, basisPoints: 6000 },
            { memberId: f.bob.memberId, basisPoints: 4000 },
          ],
        },
      });
      const before = await allocationRows(id);
      const result = await update(f.alice, id, { description: '内容だけ直す', amountMinor: 10001 });
      assert.equal(result.status, 200);
      assert.deepEqual(await allocationRows(id), before);
      assert.equal(result.body.expense.allocations.length, 2);
    });

    it('金額指定の合計が新しい金額と合わなければ400', async () => {
      const f = await createFixture();
      const id = await register(f);
      const result = await update(f.alice, id, {
        amountMinor: 1000,
        split: {
          method: 'fixed',
          amounts: [
            { memberId: f.alice.memberId, amountMinor: 400 },
            { memberId: f.bob.memberId, amountMinor: 500 },
          ],
        },
      });
      assert.deepEqual(result, { status: 400, body: { error: 'invalid_request', field: 'split.amounts' } });
      assert.equal((await expenseRow(id))!.amount_minor, 4280);
    });

    it('登録する月を、登録できる別の月に移せる。登録できない月・締め済みの月には移せない', async () => {
      const f = await createFixture();
      const id = await register(f, { targetMonth: '2026-11' });
      assert.equal((await update(f.alice, id, { targetMonth: '2026-10' })).status, 200);
      assert.equal((await expenseRow(id))!.target_month, '2026-10');
      assert.deepEqual(await update(f.alice, id, { targetMonth: '2026-12' }), {
        status: 409,
        body: { error: 'month_not_registerable', from: '2026-10', to: '2026-11' },
      });
      assert.equal((await expenseRow(id))!.target_month, '2026-10');
    });

    it('支払者を、その月に使えないメンバーに変えると409。使えるメンバーなら変えられる', async () => {
      const f = await createFixture();
      const id = await register(f);
      assert.deepEqual(await update(f.alice, id, { payerMemberId: f.daveMemberId }), {
        status: 409,
        body: { error: 'member_not_available', memberId: f.daveMemberId },
      });
      assert.deepEqual(await update(f.alice, id, { payerMemberId: f.other.member.memberId }), {
        status: 400,
        body: { error: 'invalid_request', field: 'payerMemberId' },
      });
      assert.equal((await update(f.alice, id, { payerMemberId: f.carol.memberId })).status, 200); // 脱退月 11月まで可
    });

    it('支払者が脱退・削除した既存の支出でも、内容や日付は直せる（支払者を変えないなら再検証しない）', async () => {
      const f = await createFixture();
      const id = await register(f, { payerMemberId: f.bob.memberId });
      // 登録のあとに、bob が削除されたことにする。
      await db
        .prepare(`UPDATE group_members SET status = 'deleted', user_id = NULL, expense_end_month = '2026-11' WHERE id = ?`)
        .bind(f.bob.memberId)
        .run();
      const result = await update(f.alice, id, { description: '直した', payerMemberId: f.bob.memberId });
      assert.equal(result.status, 200);
      assert.equal(result.body.expense.description, '直した');
      assert.equal(result.body.expense.payerMemberId, f.bob.memberId);
      // 月を移すときは、その月に使えるかを見直す（削除したユーザーは選べない）。支払者を選び直せば移せる。
      assert.deepEqual(await update(f.alice, id, { targetMonth: '2026-10' }), {
        status: 409,
        body: { error: 'member_not_available', memberId: f.bob.memberId },
      });
      assert.equal((await update(f.alice, id, { targetMonth: '2026-10', payerMemberId: f.alice.memberId })).status, 200);
    });

    it('削除したメンバーが入った支出の負担を組み直すとき、そのメンバーの負担を増やすことはできない', async () => {
      const f = await createFixture();
      const id = await register(f, {
        amountMinor: 1000,
        split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
      });
      // 登録のあとに、bob が削除されたことにする。
      await db
        .prepare(`UPDATE group_members SET status = 'deleted', user_id = NULL, expense_end_month = '2026-11' WHERE id = ?`)
        .bind(f.bob.memberId)
        .run();
      const notAvailable = { status: 409, body: { error: 'member_not_available', memberId: f.bob.memberId } };

      // 本人が異議を出せない相手に、負担を寄せ直せない（500 → 1000）。
      assert.deepEqual(
        await update(f.alice, id, {
          split: {
            method: 'fixed',
            amounts: [
              { memberId: f.alice.memberId, amountMinor: 0 },
              { memberId: f.bob.memberId, amountMinor: 1000 },
            ],
          },
        }),
        notAvailable,
      );
      // 金額を増やして均等に割り直すと、bob の負担が増える（500 → 1000）ので同じ。
      assert.deepEqual(
        await update(f.alice, id, {
          amountMinor: 2000,
          split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
        }),
        notAvailable,
      );
      assert.deepEqual((await allocationRows(id)).map((row) => row.burden_minor), [500, 500]);

      // 画面が負担の指定ごと送り直してくる編集（負担額は変わらない）は通る。
      assert.equal(
        (await update(f.alice, id, {
          description: '内容だけ直す',
          split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
        })).status,
        200,
      );
      // bob の負担を増やさない組み直しは通る（金額を増やした分は alice が負担する）。
      const result = await update(f.alice, id, {
        amountMinor: 1500,
        split: {
          method: 'fixed',
          amounts: [
            { memberId: f.alice.memberId, amountMinor: 1000 },
            { memberId: f.bob.memberId, amountMinor: 500 },
          ],
        },
      });
      assert.equal(result.status, 200);
      assert.deepEqual((await allocationRows(id)).map((row) => row.burden_minor), [1000, 500]);
      // 新しく加えるメンバーは、負担が0でも、使えるメンバーでなければならない。
      assert.deepEqual(
        await update(f.alice, id, {
          amountMinor: 1500,
          split: {
            method: 'ratio',
            shares: [
              { memberId: f.alice.memberId, basisPoints: 10000 },
              { memberId: f.daveMemberId, basisPoints: 0 },
            ],
          },
        }),
        { status: 409, body: { error: 'member_not_available', memberId: f.daveMemberId } },
      );
      // グループに居ないメンバーは、負担を増やすかどうかに関わらず400。
      assert.deepEqual(
        await update(f.alice, id, {
          amountMinor: 1500,
          split: {
            method: 'ratio',
            shares: [
              { memberId: f.alice.memberId, basisPoints: 10000 },
              { memberId: f.other.member.memberId, basisPoints: 0 },
            ],
          },
        }),
        { status: 400, body: { error: 'invalid_request', field: 'split.shares' } },
      );
    });

    it('アーカイブした費目の支出は、費目を変えないかぎり、別の月へも移せる（月に依らない規則は見直さない）', async () => {
      const f = await createFixture();
      const id = await register(f, { targetMonth: '2026-11' });
      await db.prepare('UPDATE categories SET archived_at = ? WHERE id = ?').bind(NOW, f.categoryId).run();
      const result = await update(f.alice, id, { targetMonth: '2026-10' });
      assert.equal(result.status, 200);
      assert.equal(result.body.expense.targetMonth, '2026-10');
    });

    it('アーカイブした費目に変えられない。すでにアーカイブした費目の支出は、そのまま直せる', async () => {
      const f = await createFixture();
      const id = await register(f);
      assert.deepEqual(await update(f.alice, id, { categoryId: f.archivedCategoryId }), {
        status: 409,
        body: { error: 'category_not_available' },
      });
      await db.prepare('UPDATE categories SET archived_at = ? WHERE id = ?').bind(NOW, f.categoryId).run();
      assert.equal((await update(f.alice, id, { description: 'アーカイブ後の編集' })).status, 200);
      assert.deepEqual(await update(f.alice, id, { categoryId: f.other.categoryId }), {
        status: 400,
        body: { error: 'invalid_request', field: 'categoryId' },
      });
    });

    it('締め済みの月の支出は編集できない', async () => {
      const f = await createFixture();
      const id = await register(f, { targetMonth: '2026-10' });
      await insertClosing(db, f.groupId, '2026-10', f.alice.memberId);
      const before = await dataVersion(f.groupId);
      assert.deepEqual(await update(f.alice, id, { amountMinor: 1 }), { status: 409, body: { error: 'month_closed' } });
      assert.equal((await expenseRow(id))!.amount_minor, 4280);
      assert.equal(await dataVersion(f.groupId), before);
    });

    it('入力が空・不正なら400', async () => {
      const f = await createFixture();
      const id = await register(f);
      // 項目を特定できない不備には、field を付けない。
      assert.deepEqual(await update(f.alice, id, {}), { status: 400, body: { error: 'invalid_request' } });
      assert.equal((await update(f.alice, id, { amountMinor: -5 })).status, 400);
      assert.equal((await update(f.alice, id, { id: 'other' })).status, 400);
    });

    describe('認証と権限', () => {
      it('セッションが無ければ401', async () => {
        const f = await createFixture();
        const id = await register(f);
        assert.equal((await update(null, id, { amountMinor: 1 })).status, 401);
      });

      it('他のグループの支出・メンバーでない人・存在しないIDは、どれも404で、何も変わらない', async () => {
        const f = await createFixture();
        const id = await register(f);
        for (const who of [f.outsider, f.other.member, f.erin]) {
          assert.deepEqual(await update(who, id, { amountMinor: 1 }), { status: 404, body: { error: 'not_found' } });
        }
        assert.deepEqual(await update(f.alice, 'no-such-expense', { amountMinor: 1 }), {
          status: 404,
          body: { error: 'not_found' },
        });
        assert.equal((await expenseRow(id))!.amount_minor, 4280);
      });

      it('脱退が確定したメンバー（leaving）は編集できない（403）', async () => {
        const f = await createFixture();
        const id = await register(f);
        assert.deepEqual(await update(f.carol, id, { amountMinor: 1 }), { status: 403, body: { error: 'forbidden' } });
      });

      it('参加する前の月の支出は、新しいメンバーには存在しないものとして扱う（404）', async () => {
        const f = await createFixture();
        const id = await register(f, { targetMonth: '2026-10' });
        assert.equal((await update(f.newbie, id, { amountMinor: 1 })).status, 404);
        assert.equal((await remove(f.newbie, id)).status, 404);
        assert.notEqual(await expenseRow(id), null);
      });
    });
  });

  // === 削除 ====================================================================================

  describe('削除（DELETE /expenses/:id）', () => {
    it('支出と、その負担額を消す', async () => {
      const f = await createFixture();
      const id = await register(f, {
        amountMinor: 1000,
        split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
      });
      const keep = await register(f, {
        amountMinor: 600,
        split: { method: 'single', memberId: f.alice.memberId },
      });
      const before = await dataVersion(f.groupId);

      const result = await remove(f.bob, id);
      assert.deepEqual(result, { status: 204, body: null });
      assert.equal(await expenseRow(id), null);
      assert.deepEqual(await allocationRows(id), []);
      assert.equal(await dataVersion(f.groupId), before + 1);
      // 他の支出は消さない。
      assert.notEqual(await expenseRow(keep), null);
      assert.equal((await allocationRows(keep)).length, 1);
    });

    it('消した支出は、もう一度消そうとすると404', async () => {
      const f = await createFixture();
      const id = await register(f);
      assert.equal((await remove(f.alice, id)).status, 204);
      assert.equal((await remove(f.alice, id)).status, 404);
    });

    it('締め済みの月の支出は消せない', async () => {
      const f = await createFixture();
      const id = await register(f, { targetMonth: '2026-10' });
      await insertClosing(db, f.groupId, '2026-10', f.alice.memberId);
      assert.deepEqual(await remove(f.alice, id), { status: 409, body: { error: 'month_closed' } });
      assert.notEqual(await expenseRow(id), null);
    });

    it('他のグループの支出・メンバーでない人は404、leaving は403、セッションが無ければ401', async () => {
      const f = await createFixture();
      const id = await register(f);
      assert.equal((await remove(f.outsider, id)).status, 404);
      assert.equal((await remove(f.other.member, id)).status, 404);
      assert.equal((await remove(f.carol, id)).status, 403);
      assert.equal((await remove(null, id)).status, 401);
      assert.notEqual(await expenseRow(id), null);
    });
  });

  // === 一覧 ====================================================================================

  describe('一覧（GET /groups/:id/expenses?month=）', () => {
    it('その月の支出を、日付の新しい順に、負担額つきで返す。ほかの月・ほかのグループの支出は含めない', async () => {
      const f = await createFixture();
      const older = await register(f, { expenseDate: '2026-11-03', description: '古い' });
      const newer = await register(f, {
        expenseDate: '2026-11-10',
        description: '新しい',
        amountMinor: 1000,
        split: { method: 'equal', memberIds: [f.alice.memberId, f.bob.memberId] },
      });
      await register(f, { targetMonth: '2026-10', description: '10月分' });
      // 別のグループの支出
      await create(f, f.other.member, {
        expenseDate: '2026-11-11',
        targetMonth: '2026-11',
        amountMinor: 1,
        categoryId: f.other.categoryId,
        payerMemberId: f.other.member.memberId,
        split: { method: 'category' },
      }, { groupId: f.other.groupId });

      const result = await list(f, f.bob, '2026-11');
      assert.equal(result.status, 200);
      assert.equal(result.body.month, '2026-11');
      assert.equal(result.body.closed, false);
      assert.deepEqual(
        result.body.expenses.map((expense: { id: string }) => expense.id),
        [newer, older],
      );
      assert.deepEqual(result.body.expenses[0].allocations, [
        { memberId: f.alice.memberId, burdenMinor: 500, shareBasisPoints: null },
        { memberId: f.bob.memberId, burdenMinor: 500, shareBasisPoints: null },
      ]);
      assert.deepEqual(result.body.expenses[1].allocations, []);
    });

    it('同じ日付なら、登録の新しい順', async () => {
      const f = await createFixture();
      const first = await register(f, { expenseDate: '2026-11-10' });
      const result2 = await create(f, f.alice, body(f, { expenseDate: '2026-11-10' }), { now: NOW + 1000 });
      const second = result2.body.expense.id as string;
      const result = await list(f, f.alice, '2026-11');
      assert.deepEqual(
        result.body.expenses.map((expense: { id: string }) => expense.id),
        [second, first],
      );
    });

    it('支出が無い月は空の配列。締め済みの月は closed が true', async () => {
      const f = await createFixture();
      assert.deepEqual((await list(f, f.alice, '2026-10')).body, { month: '2026-10', closed: false, expenses: [] });
      await insertClosing(db, f.groupId, '2026-10', f.alice.memberId);
      assert.deepEqual((await list(f, f.alice, '2026-10')).body, { month: '2026-10', closed: true, expenses: [] });
    });

    it('締め済みの月の支出も、読める', async () => {
      const f = await createFixture();
      const id = await register(f, { targetMonth: '2026-10' });
      await insertClosing(db, f.groupId, '2026-10', f.alice.memberId);
      const result = await list(f, f.alice, '2026-10');
      assert.equal(result.body.closed, true);
      assert.equal(result.body.expenses[0].id, id);
    });

    it('month が無い・形が違えば400', async () => {
      const f = await createFixture();
      for (const month of [null, '2026-13', '202611', 'abc']) {
        assert.deepEqual(await list(f, f.alice, month), { status: 400, body: { error: 'invalid_request', field: 'month' } });
      }
    });

    it('セッションが無ければ401。メンバーでない人・脱退済みは404', async () => {
      const f = await createFixture();
      assert.equal((await list(f, null, '2026-11')).status, 401);
      assert.equal((await list(f, f.outsider, '2026-11')).status, 404);
      assert.equal((await list(f, f.other.member, '2026-11')).status, 404);
      assert.equal((await list(f, f.erin, '2026-11')).status, 404);
      assert.equal((await list(f, f.alice, '2026-11', 'no-such-group')).status, 404);
    });

    it('脱退が確定したメンバー（leaving）は、グループのデータを見られる', async () => {
      const f = await createFixture();
      const id = await register(f);
      const result = await list(f, f.carol, '2026-11');
      assert.equal(result.status, 200);
      assert.equal(result.body.expenses[0].id, id);
    });

    it('新しいメンバーは、参加した月より前の月を見られない（403）。参加した月は、参加前の日付の支出も見られる', async () => {
      const f = await createFixture();
      await register(f, { targetMonth: '2026-10' });
      const early = await register(f, { targetMonth: '2026-11', expenseDate: '2026-11-01' });
      assert.deepEqual(await list(f, f.newbie, '2026-10'), { status: 403, body: { error: 'forbidden' } });
      const result = await list(f, f.newbie, '2026-11');
      assert.equal(result.status, 200);
      assert.equal(result.body.expenses[0].id, early);
    });
  });

  // === 入口（ルーティング）=======================================================================

  describe('入口', () => {
    const fetchApi = async (method: string, path: string, token: string | null, payload?: unknown) =>
      read(await worker.fetch(request(method, path, token, payload), env));

    it('URLとメソッドで、各APIに振り分ける', async () => {
      const f = await createFixture();
      const id = await register(f);
      // 登録は、いまの時刻（Date.now()）で動く。時計に依らないよう、入力の不備で400になること（=登録のAPIに届いたこと）を見る。
      assert.deepEqual(await fetchApi('POST', `/groups/${f.groupId}/expenses`, f.alice.token, {}), {
        status: 400,
        body: { error: 'invalid_request', field: 'expenseDate' },
      });
      assert.equal((await fetchApi('GET', `/groups/${f.groupId}/expenses?month=2026-11`, f.alice.token)).status, 200);
      assert.equal((await fetchApi('PATCH', `/expenses/${id}`, f.alice.token, { amountMinor: 1 })).status, 200);
      assert.equal((await fetchApi('DELETE', `/expenses/${id}`, f.alice.token)).status, 204);
    });

    it('認証なしは401、知らないパスは404、許さないメソッドは405', async () => {
      const f = await createFixture();
      assert.equal((await fetchApi('GET', `/groups/${f.groupId}/expenses?month=2026-11`, null)).status, 401);
      const unknown = await worker.fetch(request('GET', '/nope', null), env);
      assert.equal(unknown.status, 404);
      // 知らないパスも、他の404と同じ形（アプリがエラーをJSONとして読めるように）。
      assert.deepEqual(await unknown.json(), { error: 'not_found' });
      assert.equal(unknown.headers.get('cache-control'), 'no-store');
      const put = await worker.fetch(request('PUT', `/groups/${f.groupId}/expenses`, f.alice.token), env);
      assert.equal(put.status, 405);
      assert.equal(put.headers.get('allow'), 'GET, POST');
      const post = await worker.fetch(request('POST', '/expenses/abc', f.alice.token), env);
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'PATCH, DELETE');
    });

    it('IDの形が違うパスは404', async () => {
      const f = await createFixture();
      assert.equal((await fetchApi('GET', '/groups/a%20b/expenses?month=2026-11', f.alice.token)).status, 404);
      assert.equal((await fetchApi('DELETE', '/expenses/%E3%81%82', f.alice.token)).status, 404);
    });

    it('HTTPSでないリクエストは、中身を見ずに403', async () => {
      const response = await worker.fetch(
        new Request('http://example.test/groups/x/expenses?month=2026-11', { method: 'GET' }),
        env,
      );
      assert.equal(response.status, 403);
    });
  });
});
