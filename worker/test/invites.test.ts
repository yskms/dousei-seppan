/// <reference types="node" />
// 招待の発行・一覧・取り消し・確認、参加のAPI（src/invites.ts）の検査。規則は docs/backend-design.md 5章、形は9章
// 「招待・参加・脱退」。ローカルD1（miniflare）での検査なので、確かめるのはロジック。競合は「読んだあとに別の書き込みが
// 入った」状況で再現して確かめている（本番D1での確認は13章の9）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { deleteAccount } from '../src/accountDeletion.ts';
import worker from '../src/index.ts';
import { INVITE_TTL_MS, MAX_UNUSED_INVITES_PER_MEMBER } from '../src/invites.ts';
import {
  createFixtureFactory,
  equalShares,
  insertCategoryRule,
  insertClosing,
  insertInviteRow,
  insertRecurringRow,
  NOW,
  type MemberOptions,
  type Person,
} from './apiFixture.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';
import { membershipApi } from './membershipApi.ts';
import { interferingEnv, NOW_DECEMBER, read, request } from './monthApi.ts';

describe('招待・参加のAPI', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let env: Env;
  let factory: ReturnType<typeof createFixtureFactory>;
  let api: ReturnType<typeof membershipApi>;

  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
    env = local.env;
    factory = createFixtureFactory(db);
    api = membershipApi(env);
  });
  after(async () => {
    await local.dispose();
  });

  // --- 準備の道具 -------------------------------------------------------------------------------

  /** alice・bob の2人（2026-10から参加中）と、費目1つ。2026-10の割合は均等。 */
  const setup = async (options: Partial<Record<'alice' | 'bob', MemberOptions>> = {}) => {
    const group = await factory.createGroup(['alice', 'bob'], options);
    await insertCategoryRule(
      db,
      group.groupId,
      group.categoryId,
      '2026-10',
      equalShares([group.people.alice.memberId, group.people.bob.memberId]),
    );
    return group;
  };
  const dataVersion = async (groupId: string) =>
    (await db.prepare('SELECT data_version FROM expense_groups WHERE id = ?').bind(groupId).first<{ data_version: number }>())!
      .data_version;
  const memberRows = async (groupId: string) =>
    (
      await db
        .prepare(
          `SELECT id, user_id, display_name, color, status, history_from_month, leave_requested_month,
                  expense_end_month, joined_at, left_at FROM group_members WHERE group_id = ? ORDER BY id`,
        )
        .bind(groupId)
        .all<Record<string, unknown>>()
    ).results;
  const inviteRow = (inviteId: string) =>
    db
      .prepare('SELECT * FROM invites WHERE id = ?')
      .bind(inviteId)
      .first<{
        token_hash: string;
        consumed_at: number | null;
        consumed_by_member_id: string | null;
        revoked_at: number | null;
        expires_at: number;
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
  const outsider = (name: string): Promise<Person> => factory.addUser(name);

  // === 発行 ===================================================================================

  describe('招待の発行（POST /groups/:id/invites）', () => {
    it('発行すると、期限は3日後で、トークンの平文は応答でだけ返す。D1にはハッシュだけを置く', async () => {
      const g = await setup();
      const before = await dataVersion(g.groupId);
      const result = await api.createInvite(g.people.alice, g.groupId);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      const { id, token, expiresAt, createdAt } = result.body.invite;
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.deepEqual([expiresAt, createdAt], [NOW + INVITE_TTL_MS, NOW]);
      assert.equal(INVITE_TTL_MS, 3 * 24 * 60 * 60 * 1000);

      const row = await inviteRow(id);
      assert.equal(row!.token_hash, createHash('sha256').update(token).digest('base64url'));
      assert.notEqual(row!.token_hash, token);
      const { results } = await db.prepare('SELECT count(*) AS n FROM invites WHERE token_hash = ?').bind(token).all<{ n: number }>();
      assert.equal(results[0]!.n, 0, '平文は保存しない');
      assert.equal(await dataVersion(g.groupId), before + 1);
    });

    it('発行するたびに、別のトークンになる', async () => {
      const g = await setup();
      const a = await api.createInvite(g.people.alice, g.groupId);
      const b = await api.createInvite(g.people.alice, g.groupId);
      assert.notEqual(a.body.invite.token, b.body.invite.token);
      assert.notEqual(a.body.invite.id, b.body.invite.id);
    });

    it('脱退を選んだだけ（月が終わっていない）なら、発行できる。確定した（leaving）人・月が終わった人は、できない（403）', async () => {
      const g = await setup({ alice: { leaveRequestedMonth: '2026-11' } });
      assert.equal((await api.createInvite(g.people.alice, g.groupId)).status, 201);
      // 脱退月（2026-11）が終わったあと。Cronの確定を待たずに、確定したものとして扱う。
      assert.deepEqual(
        (await api.createInvite(g.people.alice, g.groupId, { now: NOW_DECEMBER })).status,
        403,
      );
      const h = await setup({ alice: { status: 'leaving', expenseEndMonth: '2026-11', leaveRequestedMonth: '2026-11' } });
      const result = await api.createInvite(h.people.alice, h.groupId);
      assert.deepEqual([result.status, result.body], [403, { error: 'forbidden' }]);
      assert.equal((await api.createInvite(h.people.bob, h.groupId)).status, 201, '残るメンバーは発行できる');
    });

    it('認証・所属: セッション無し401、メンバーでない人・脱退済み・他のグループは404。何も書かれない', async () => {
      const g = await setup();
      const other = await setup();
      const left = await factory.addPerson(g.groupId, 'erin', { status: 'left', expenseEndMonth: '2026-10' });
      const before = await dataVersion(g.groupId);
      assert.equal((await api.createInvite(null, g.groupId)).status, 401);
      for (const who of [await outsider('zed'), left, other.people.alice]) {
        const result = await api.createInvite(who, g.groupId);
        assert.deepEqual([result.status, result.body], [404, { error: 'not_found' }]);
      }
      assert.equal((await api.createInvite(g.people.alice, 'no-such-group')).status, 404);
      assert.equal(await dataVersion(g.groupId), before);
    });

    it(`未使用で期限内の招待は、1人 ${MAX_UNUSED_INVITES_PER_MEMBER} 件まで（409 too_many_invites）。期限切れ・取り消し済み・使用済みは数えない`, async () => {
      const g = await setup();
      const { alice, bob } = g.people;
      // 数えないもの。
      await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId, expiresAt: NOW - 1 });
      await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId, revokedAt: NOW });
      await insertInviteRow(db, {
        groupId: g.groupId,
        invitedByMemberId: alice.memberId,
        consumed: { memberId: bob.memberId, at: NOW },
      });
      for (let i = 0; i < MAX_UNUSED_INVITES_PER_MEMBER; i++) {
        assert.equal((await api.createInvite(alice, g.groupId)).status, 201, `${i + 1}件目`);
      }
      const over = await api.createInvite(alice, g.groupId);
      assert.deepEqual([over.status, over.body], [409, { error: 'too_many_invites' }]);
      // 上限はメンバーごと。
      assert.equal((await api.createInvite(bob, g.groupId)).status, 201);
    });

    it('競合: 読んだあとに別の書き込みが入っても、1回だけやり直して成功する。続けて競合したら409', async () => {
      const g = await setup();
      const bump = () => db.prepare('UPDATE expense_groups SET data_version = data_version + 1 WHERE id = ?').bind(g.groupId).run();
      const once = await api.createInvite(g.people.alice, g.groupId, { env: interferingEnv(env, bump, { times: 1 }) });
      assert.equal(once.status, 201);
      const before = await dataVersion(g.groupId);
      const twice = await api.createInvite(g.people.alice, g.groupId, { env: interferingEnv(env, bump, { times: 2 }) });
      assert.deepEqual([twice.status, twice.body], [409, { error: 'conflict' }]);
      assert.equal(await dataVersion(g.groupId), before + 2, '増えたのは、割り込んだ2回分だけ');
    });
  });

  // === 一覧 ===================================================================================

  describe('招待の一覧（GET /groups/:id/invites）', () => {
    it('自分が発行した、未使用で期限内の招待だけを返す', async () => {
      const g = await setup();
      const { alice, bob } = g.people;
      const mine = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId });
      await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId, expiresAt: NOW - 1 });
      await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId, revokedAt: NOW });
      await insertInviteRow(db, {
        groupId: g.groupId,
        invitedByMemberId: alice.memberId,
        consumed: { memberId: bob.memberId, at: NOW },
      });
      await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: bob.memberId });

      const result = await api.listInvites(alice, g.groupId);
      assert.deepEqual(result.body, { invites: [{ id: mine.id, expiresAt: NOW + INVITE_TTL_MS, createdAt: NOW }] });
      assert.equal((await api.listInvites(null, g.groupId)).status, 401);
      assert.equal((await api.listInvites(await outsider('zed'), g.groupId)).status, 404);
    });
  });

  // === 取り消し ===============================================================================

  describe('招待の取り消し（DELETE /invites/:id）', () => {
    it('発行した人が取り消すと、204。取り消した招待では、確認も参加もできない', async () => {
      const g = await setup();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const before = await dataVersion(g.groupId);
      const result = await api.revokeInvite(g.people.alice, invite.id);
      assert.deepEqual([result.status, result.body], [204, null]);
      assert.equal((await inviteRow(invite.id))!.revoked_at, NOW);
      assert.equal(await dataVersion(g.groupId), before + 1);

      const visitor = await outsider('visitor');
      assert.deepEqual((await api.getInvite(visitor, invite.token)).body, { error: 'invite_unavailable' });
      assert.equal((await api.join(visitor, invite.token)).status, 404);
    });

    it('発行した人以外・メンバーでない人・知らないID・他のグループは、無いものとして404', async () => {
      const g = await setup();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      for (const who of [g.people.bob, await outsider('zed')]) {
        const result = await api.revokeInvite(who, invite.id);
        assert.deepEqual([result.status, result.body], [404, { error: 'not_found' }]);
      }
      assert.equal((await api.revokeInvite(g.people.alice, 'no-such-invite')).status, 404);
      assert.equal((await api.revokeInvite(null, invite.id)).status, 401);
      assert.equal((await inviteRow(invite.id))!.revoked_at, null);
    });

    it('使用済みの招待は取り消せない（409 invite_already_used）。取り消し済みは、そのまま204（時刻は変えない）', async () => {
      const g = await setup();
      const { alice, bob } = g.people;
      const used = await insertInviteRow(db, {
        groupId: g.groupId,
        invitedByMemberId: alice.memberId,
        consumed: { memberId: bob.memberId, at: NOW },
      });
      const result = await api.revokeInvite(alice, used.id);
      assert.deepEqual([result.status, result.body], [409, { error: 'invite_already_used' }]);
      assert.equal((await inviteRow(used.id))!.revoked_at, null);

      const revoked = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId, revokedAt: 777 });
      const before = await dataVersion(g.groupId);
      assert.equal((await api.revokeInvite(alice, revoked.id)).status, 204);
      assert.equal((await inviteRow(revoked.id))!.revoked_at, 777);
      assert.equal(await dataVersion(g.groupId), before, '何も書かないので、バージョンも上がらない');
    });
  });

  // === 確認 ===================================================================================

  describe('招待内容の確認（GET /invites/:token）', () => {
    it('グループ名と招待元を返す。URLを開いただけでは参加しない（メンバーも招待の状態も変わらない）', async () => {
      const g = await setup();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const visitor = await outsider('visitor');
      const members = await memberRows(g.groupId);
      const before = await dataVersion(g.groupId);

      const result = await api.getInvite(visitor, invite.token);
      assert.deepEqual(result.body, {
        alreadyMember: false,
        groupName: 'ふたりの生活費',
        invitedByDisplayName: 'alice',
        expiresAt: NOW + INVITE_TTL_MS,
      });
      assert.deepEqual(await memberRows(g.groupId), members);
      assert.deepEqual([(await inviteRow(invite.id))!.consumed_at, await dataVersion(g.groupId)], [null, before]);
    });

    it('すでに参加中（脱退が確定した人を含む）なら、グループを開くための情報だけを返す。使用済みの招待でも同じ', async () => {
      const g = await setup();
      const carol = await factory.addPerson(g.groupId, 'carol', { status: 'leaving', expenseEndMonth: '2026-11' });
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const used = await insertInviteRow(db, {
        groupId: g.groupId,
        invitedByMemberId: g.people.alice.memberId,
        consumed: { memberId: g.people.bob.memberId, at: NOW },
      });
      for (const who of [g.people.bob, carol]) {
        assert.deepEqual((await api.getInvite(who, invite.token)).body, { alreadyMember: true, groupId: g.groupId });
      }
      assert.deepEqual((await api.getInvite(g.people.bob, used.token)).body, { alreadyMember: true, groupId: g.groupId });
    });

    it('使えない招待は、理由を区別せず404 invite_unavailable（知らないトークン・期限切れ・取り消し済み・使用済み・発行者が抜けた）', async () => {
      const g = await setup();
      const { alice, bob } = g.people;
      const gone = await factory.addPerson(g.groupId, 'gone', { status: 'left', expenseEndMonth: '2026-10' });
      const leaving = await factory.addPerson(g.groupId, 'leaving', { status: 'leaving', expenseEndMonth: '2026-11' });
      const stale = await factory.addPerson(g.groupId, 'stale', { leaveRequestedMonth: '2026-10' });
      const tokens = [
        'x'.repeat(43), // 知らないトークン
        (await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId, expiresAt: NOW })).token,
        (await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId, revokedAt: NOW })).token,
        (
          await insertInviteRow(db, {
            groupId: g.groupId,
            invitedByMemberId: alice.memberId,
            consumed: { memberId: bob.memberId, at: NOW },
          })
        ).token,
        (await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: gone.memberId })).token,
        (await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: leaving.memberId })).token,
        // 脱退月（2026-10）が終わっているのに、Cronがまだ確定させていない人の招待。
        (await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: stale.memberId })).token,
      ];
      const visitor = await outsider('visitor');
      for (const token of tokens) {
        const result = await api.getInvite(visitor, token);
        assert.deepEqual([result.status, result.body], [404, { error: 'invite_unavailable' }], token);
      }
      assert.equal((await api.getInvite(null, tokens[0]!)).status, 401);
    });

    it('発行者が、脱退を選んだだけ（月が終わっていない）なら、招待は使える', async () => {
      const g = await setup({ alice: { leaveRequestedMonth: '2026-11' } });
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      assert.equal((await api.getInvite(await outsider('visitor'), invite.token)).status, 200);
    });

    it('招待トークンの形でないパスは、JSONの404（ルーティング）', async () => {
      const response = await worker.fetch(request('GET', '/invites/short', 'x'.repeat(43)), env);
      assert.deepEqual(await read(response), { status: 404, body: { error: 'not_found' } });
    });
  });

  // === 参加 ===================================================================================

  describe('参加（POST /invites/:token/join）', () => {
    it('参加すると、メンバーに加わり、履歴は参加月から。招待は使用済みになり、バージョンが上がる', async () => {
      const g = await setup();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const visitor = await outsider('visitor');
      const before = await dataVersion(g.groupId);

      const result = await api.join(visitor, invite.token, { displayName: '  みっちゃん  ' });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.groupId, g.groupId);
      const memberId = result.body.memberId as string;

      const rows = await memberRows(g.groupId);
      const added = rows.find((row) => row.id === memberId)!;
      assert.deepEqual(
        [added.user_id, added.display_name, added.status, added.history_from_month, added.joined_at, added.leave_requested_month],
        [visitor.userId, 'みっちゃん', 'active', '2026-11', NOW, null],
      );
      // 色は、他の参加中のメンバーと重ならない（テストの準備では、全員 'pink'）。
      assert.notEqual(added.color, 'pink');
      assert.deepEqual(
        [(await inviteRow(invite.id))!.consumed_at, (await inviteRow(invite.id))!.consumed_by_member_id],
        [NOW, memberId],
      );
      assert.equal(await dataVersion(g.groupId), before + 1);

      // 参加したので、確認は「参加中」を返し、同じ招待で、もう一度は参加できない。
      assert.deepEqual((await api.getInvite(visitor, invite.token)).body, { alreadyMember: true, groupId: g.groupId });
      const again = await api.join(visitor, invite.token);
      assert.deepEqual([again.status, again.body], [409, { error: 'already_member', groupId: g.groupId }]);
    });

    it('参加月の全費目（アーカイブ済みも）の割合を、新しいメンバーを含めた均等にリセットし、上限額を外す。ほかの月は変えない', async () => {
      const g = await setup();
      const { alice, bob } = g.people;
      const archivedId = await factory.addCategory(g.groupId, 'old', true);
      await insertCategoryRule(db, g.groupId, archivedId, '2026-10', equalShares([alice.memberId, bob.memberId]));
      await insertCategoryRule(
        db,
        g.groupId,
        g.categoryId,
        '2026-11',
        [
          [alice.memberId, 8000],
          [bob.memberId, 2000],
        ],
        { memberId: alice.memberId, capMinor: 3000 },
      );
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId });

      const result = await api.join(await outsider('visitor'), invite.token);
      assert.equal(result.status, 201);
      const ids = [alice.memberId, bob.memberId, result.body.memberId as string];
      for (const categoryId of [g.categoryId, archivedId]) {
        assert.deepEqual(await sharesOf(categoryId, '2026-11'), equalShares(ids).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
        assert.deepEqual(await settingsOf(categoryId, '2026-11'), { cap_member_id: null, cap_minor: null });
      }
      // 参加月より前の月の割合は、そのまま（2人の均等）。
      assert.equal((await sharesOf(g.categoryId, '2026-10')).length, 2);
    });

    it('参加月より後の月に、割合の行が残っていれば、それも直す（アカウント削除が、未締めの翌月に書いた行に、参加した人が入る）', async () => {
      const g = await setup();
      const { alice, bob } = g.people;
      await deleteAccount(db, alice.userId, NOW); // 2026-12 の行が、残る bob だけで書かれる
      assert.deepEqual(await sharesOf(g.categoryId, '2026-12'), [[bob.memberId, 10000]]);
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: bob.memberId });

      const result = await api.join(await outsider('visitor'), invite.token);
      assert.equal(result.status, 201);
      const newcomer = result.body.memberId as string;
      // 参加月（2026-11）は、削除した alice（削除した月まで集計に入る）・bob・新しいメンバーの3人。
      assert.equal((await sharesOf(g.categoryId, '2026-11')).length, 3);
      // 翌月（2026-12）は、alice が抜けたあとの、bob と新しいメンバーの2人の均等。
      assert.deepEqual(
        (await sharesOf(g.categoryId, '2026-12')).map((row) => row[0]).sort(),
        [bob.memberId, newcomer].sort(),
      );
      assert.deepEqual((await sharesOf(g.categoryId, '2026-12')).map((row) => row[1]), [5000, 5000]);
    });

    it('category 以外の固定費は止める（member_changed）。category の固定費・止まっている固定費は変えない', async () => {
      const g = await setup();
      const { alice } = g.people;
      const equal = await insertRecurringRow(db, { groupId: g.groupId, categoryId: g.categoryId, payerMemberId: alice.memberId, splitMethod: 'equal' });
      const category = await insertRecurringRow(db, { groupId: g.groupId, categoryId: g.categoryId, payerMemberId: alice.memberId });
      const manual = await insertRecurringRow(db, {
        groupId: g.groupId,
        categoryId: g.categoryId,
        payerMemberId: alice.memberId,
        splitMethod: 'fixed',
        pausedReason: 'manual',
      });
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId });
      assert.equal((await api.join(await outsider('visitor'), invite.token)).status, 201);
      assert.deepEqual(
        [await pausedReason(equal), await pausedReason(category), await pausedReason(manual)],
        ['member_changed', null, 'manual'],
      );
    });

    it('参加月がすでに締められているとき（早めに締めた後）は、締めた月の割合には触れず、翌月をリセットする', async () => {
      const g = await setup();
      const { alice, bob } = g.people;
      await insertCategoryRule(db, g.groupId, g.categoryId, '2026-11', equalShares([alice.memberId, bob.memberId]));
      await insertClosing(db, g.groupId, '2026-11', alice.memberId);
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId });

      const result = await api.join(await outsider('visitor'), invite.token);
      assert.equal(result.status, 201);
      assert.equal((await sharesOf(g.categoryId, '2026-11')).length, 2, '締めた月は、そのまま');
      assert.equal((await sharesOf(g.categoryId, '2026-12')).length, 3);
      const added = (await memberRows(g.groupId)).find((row) => row.id === result.body.memberId)!;
      assert.equal(added.history_from_month, '2026-11', '履歴は参加月（締めた月）から');
    });

    it('一度脱退した人（left）は、元のメンバー行に戻る。履歴は復帰した月から、脱退の記録は消える', async () => {
      const g = await setup();
      const erin = await factory.addPerson(g.groupId, 'erin', { status: 'left', expenseEndMonth: '2026-10', leaveRequestedMonth: '2026-10' });
      await db.prepare('UPDATE group_members SET left_at = 5, color = ? WHERE id = ?').bind('blue', erin.memberId).run();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const membersBefore = (await memberRows(g.groupId)).length;

      const result = await api.join(erin, invite.token, { displayName: 'えりん' });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.memberId, erin.memberId);
      const rows = await memberRows(g.groupId);
      assert.equal(rows.length, membersBefore, '行は増えない');
      const row = rows.find((r) => r.id === erin.memberId)!;
      assert.deepEqual(
        [row.status, row.display_name, row.history_from_month, row.leave_requested_month, row.expense_end_month, row.left_at, row.joined_at],
        ['active', 'えりん', '2026-11', null, null, null, NOW],
      );
      assert.equal(row.color, 'blue', '他のメンバーと重ならなければ、元の色のまま');
      assert.equal((await sharesOf(g.categoryId, '2026-11')).length, 3, '復帰した人を含めた均等');
    });

    it('すでに参加中なら409 already_member。招待は使われない', async () => {
      const g = await setup();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const before = await dataVersion(g.groupId);
      const result = await api.join(g.people.bob, invite.token);
      assert.deepEqual([result.status, result.body], [409, { error: 'already_member', groupId: g.groupId }]);
      assert.equal((await inviteRow(invite.id))!.consumed_at, null);
      assert.equal(await dataVersion(g.groupId), before);
    });

    it('使えない招待（期限切れ・取り消し済み・使用済み・知らないトークン・発行者が抜けた）には参加できない（404 invite_unavailable）。何も書かれない', async () => {
      const g = await setup();
      const { alice, bob } = g.people;
      const gone = await factory.addPerson(g.groupId, 'gone', { status: 'left', expenseEndMonth: '2026-10' });
      const tokens = [
        'x'.repeat(43),
        (await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId, expiresAt: NOW })).token,
        (await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: alice.memberId, revokedAt: NOW })).token,
        (
          await insertInviteRow(db, {
            groupId: g.groupId,
            invitedByMemberId: alice.memberId,
            consumed: { memberId: bob.memberId, at: NOW },
          })
        ).token,
        (await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: gone.memberId })).token,
      ];
      const before = await dataVersion(g.groupId);
      const members = await memberRows(g.groupId);
      for (const token of tokens) {
        const result = await api.join(await outsider('visitor'), token);
        assert.deepEqual([result.status, result.body], [404, { error: 'invite_unavailable' }], token);
      }
      assert.equal(await dataVersion(g.groupId), before);
      assert.deepEqual(await memberRows(g.groupId), members);
    });

    it('表示名の検査（400 invalid_request）: 必須・前後の空白を落として1〜20文字（コードポイント）・知らない項目は断る', async () => {
      const g = await setup();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const visitor = await outsider('visitor');
      const bad: [unknown, string | undefined][] = [
        [{}, 'displayName'],
        [{ displayName: 5 }, 'displayName'],
        [{ displayName: '   ' }, 'displayName'],
        [{ displayName: 'あ'.repeat(21) }, 'displayName'],
        [{ displayName: '😀'.repeat(21) }, 'displayName'],
        [{ displayName: 'ok', color: 'red' }, 'color'],
        [[], undefined],
      ];
      for (const [body, field] of bad) {
        const result = await api.join(visitor, invite.token, body);
        assert.deepEqual([result.status, result.body], [400, field === undefined ? { error: 'invalid_request' } : { error: 'invalid_request', field }]);
      }
      const notJson = await read(
        await worker.fetch(
          new Request(`https://example.test/invites/${invite.token}/join`, {
            method: 'POST',
            headers: { authorization: `Bearer ${visitor.token}` },
            body: '{',
          }),
          env,
        ),
      );
      assert.deepEqual(notJson, { status: 400, body: { error: 'invalid_request' } });
      assert.equal((await inviteRow(invite.id))!.consumed_at, null);
      // ちょうど20文字（絵文字を含む）は通る。
      assert.equal((await api.join(visitor, invite.token, { displayName: '😀'.repeat(20) })).status, 201);
    });

    it('認証: セッション無しは401', async () => {
      const g = await setup();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      assert.equal((await api.join(null, invite.token)).status, 401);
    });

    it('同じ招待で同時に参加しようとすると、片方だけが参加し、もう片方は409 conflict（何も書かれない）', async () => {
      const g = await setup();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const first = await outsider('first');
      const second = await outsider('second');
      // second が検証を終えたあと、書き込みの直前に、first が参加する。
      const racing = interferingEnv(env, async () => {
        assert.equal((await api.join(first, invite.token, { displayName: 'first' })).status, 201);
      });
      const result = await api.join(second, invite.token, { displayName: 'second' }, { env: racing });
      assert.deepEqual([result.status, result.body], [409, { error: 'conflict' }]);

      const rows = await memberRows(g.groupId);
      assert.deepEqual(rows.map((row) => row.user_id).filter((id) => id === first.userId || id === second.userId), [first.userId]);
      assert.equal((await inviteRow(invite.id))!.consumed_by_member_id, rows.find((row) => row.user_id === first.userId)!.id);
      // 負けた側が読み直すと、使えない招待として断られる。
      assert.deepEqual((await api.join(second, invite.token)).body, { error: 'invite_unavailable' });
    });

    it('同じ人の二重送信（同時）でも、メンバー行は1つだけ', async () => {
      const g = await setup();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const visitor = await outsider('visitor');
      const racing = interferingEnv(env, async () => {
        assert.equal((await api.join(visitor, invite.token, { displayName: 'one' })).status, 201);
      });
      const result = await api.join(visitor, invite.token, { displayName: 'two' }, { env: racing });
      assert.deepEqual([result.status, result.body], [409, { error: 'conflict' }]);
      assert.equal((await memberRows(g.groupId)).filter((row) => row.user_id === visitor.userId).length, 1);
    });

    it('色: 他のメンバーと重ならないように選ぶ。全色が使われていれば、使われている数で一巡する', async () => {
      const g = await setup();
      const used = ['pink', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'brown', 'gray'];
      for (const [index, color] of used.entries()) {
        const p = await factory.addPerson(g.groupId, `m${index}`);
        await db.prepare('UPDATE group_members SET color = ? WHERE id = ?').bind(color, p.memberId).run();
      }
      await db.prepare(`UPDATE group_members SET color = 'pink' WHERE id IN (?, ?)`).bind(g.people.alice.memberId, g.people.bob.memberId).run();
      const invite = await insertInviteRow(db, { groupId: g.groupId, invitedByMemberId: g.people.alice.memberId });
      const result = await api.join(await outsider('visitor'), invite.token);
      assert.equal(result.status, 201);
      const added = (await memberRows(g.groupId)).find((row) => row.id === result.body.memberId)!;
      // 参加中は12人で全色が使われている。12 % 10 = 2 番目の色。
      assert.equal(added.color, used[2]);
    });
  });
});
