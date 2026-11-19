/// <reference types="node" />
// D1のスキーマ（migrations/）の検査。設計は docs/backend-design.md 付録A。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';

describe('D1のスキーマ（migrations/）', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
  });
  after(async () => {
    await local.dispose();
  });

  const run = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run();
  const rejects = (sql: string, ...values: unknown[]) => assert.rejects(run(sql, ...values));

  const addUser = async () => {
    const userId = id('user');
    await run('INSERT INTO users (id, created_at) VALUES (?, ?)', userId, 1);
    return userId;
  };
  const addGroup = async () => {
    const groupId = id('group');
    await run(
      `INSERT INTO expense_groups (id, name, currency_code, currency_minor_unit, timezone, created_at)
       VALUES (?, 'ふたりの生活費', 'JPY', 0, 'Asia/Tokyo', 1)`,
      groupId,
    );
    return groupId;
  };
  const addMember = async (groupId: string, userId: string | null = null) => {
    const memberId = id('member');
    await run(
      `INSERT INTO group_members (id, group_id, user_id, display_name, color, history_from_month, joined_at)
       VALUES (?, ?, ?, 'あなた', 'pink', '2026-11', 1)`,
      memberId,
      groupId,
      userId,
    );
    return memberId;
  };
  const addCategory = async (groupId: string) => {
    const categoryId = id('category');
    await run(
      `INSERT INTO categories (id, group_id, name, icon, color, created_at) VALUES (?, ?, '食費', 'cart', 'blue', 1)`,
      categoryId,
      groupId,
    );
    return categoryId;
  };
  const insertExpense = (groupId: string, categoryId: string, payerId: string) =>
    run(
      `INSERT INTO expenses (id, group_id, expense_date, target_month, amount_minor, category_id,
         payer_member_id, created_by_member_id, split_method, created_at, updated_at)
       VALUES (?, ?, '2026-11-19', '2026-11', 4280, ?, ?, ?, 'category', 1, 1)`,
      id('expense'),
      groupId,
      categoryId,
      payerId,
      payerId,
    );
  const addClosing = async (groupId: string, memberId: string) => {
    const closingId = id('closing');
    await run(
      `INSERT INTO monthly_closings (id, group_id, target_month, currency_code, currency_minor_unit,
         data_version, closed_by_member_id, closed_at)
       VALUES (?, ?, '2026-11', 'JPY', 0, 1, ?, 1)`,
      closingId,
      groupId,
      memberId,
    );
    return closingId;
  };

  it('19のテーブルがある（wranglerの管理用のテーブルを除く）', async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = results
      .map((row) => row.name)
      .filter((name) => name !== 'd1_migrations' && !name.startsWith('sqlite_') && !name.startsWith('_cf_'));
    assert.deepEqual(names, [
      'categories',
      'category_month_settings',
      'category_month_shares',
      'closing_category_burdens',
      'closing_member_summaries',
      'expense_allocations',
      'expense_groups',
      'expenses',
      'group_members',
      'identities',
      'invites',
      'monthly_closings',
      'recurring_expense_allocations',
      'recurring_expense_runs',
      'recurring_expenses',
      'sessions',
      'settlement_transfers',
      'used_nonces',
      'users',
    ].sort());
  });

  // グループの削除（group_id で消す）と、親の行の削除（外部キーの確認）で、全グループの行を読まないため。
  it('group_id を持つテーブルには、すべて group_id が先頭の索引がある', async () => {
    const { results: tables } = await db
      .prepare(
        `SELECT m.name AS name FROM sqlite_master m
         WHERE m.type = 'table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'group_id')`,
      )
      .all<{ name: string }>();
    assert.equal(tables.length, 14);
    for (const { name } of tables) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM pragma_index_list(?1) l
           WHERE (SELECT i.name FROM pragma_index_info(l.name) i WHERE i.seqno = 0) = 'group_id'`,
        )
        .bind(name)
        .first<{ n: number }>();
      assert.ok((row?.n ?? 0) > 0, `${name} に group_id が先頭の索引が無い`);
    }
  });

  it('別のグループのメンバーを、支出の支払者にできない（複合外部キー）', async () => {
    const groupA = await addGroup();
    const groupB = await addGroup();
    const categoryA = await addCategory(groupA);
    const memberA = await addMember(groupA);
    const memberB = await addMember(groupB);
    await insertExpense(groupA, categoryA, memberA);
    await assert.rejects(insertExpense(groupA, categoryA, memberB));
  });

  it('自由入力の文字数の上限', async () => {
    const groupId = await addGroup();
    await rejects(
      `INSERT INTO group_members (id, group_id, display_name, color, history_from_month, joined_at)
       VALUES (?, ?, ?, 'pink', '2026-11', 1)`,
      id('member'),
      groupId,
      'あ'.repeat(21),
    );
    await rejects(
      `INSERT INTO categories (id, group_id, name, icon, color, created_at) VALUES (?, ?, ?, 'cart', 'blue', 1)`,
      id('category'),
      groupId,
      'あ'.repeat(21),
    );
  });

  it('上限額は、負担する人と金額を両方持つか、両方持たない', async () => {
    const groupId = await addGroup();
    const categoryId = await addCategory(groupId);
    const memberId = await addMember(groupId);
    await rejects(
      `INSERT INTO category_month_settings (group_id, category_id, target_month, cap_member_id)
       VALUES (?, ?, '2026-11', ?)`,
      groupId,
      categoryId,
      memberId,
    );
    await run(
      `INSERT INTO category_month_settings (group_id, category_id, target_month, cap_member_id, cap_minor)
       VALUES (?, ?, '2026-11', ?, 10000)`,
      groupId,
      categoryId,
      memberId,
    );
  });

  it('締めの結果: 精算する額は、差額と繰越の合計', async () => {
    const groupId = await addGroup();
    const memberId = await addMember(groupId);
    const closingId = await addClosing(groupId, memberId);
    const insert = (net: number) =>
      run(
        `INSERT INTO closing_member_summaries (group_id, closing_id, member_id, display_name_snapshot,
           paid_minor, burden_minor, difference_minor, carried_in_minor, net_minor)
         VALUES (?, ?, ?, 'あなた', 100000, 83000, 17000, -5000, ?)`,
        groupId,
        closingId,
        memberId,
        net,
      );
    await assert.rejects(insert(17000));
    await insert(12000);
  });

  it('送金: 状態と、精算・繰越の時刻の組が合わないものは入らない', async () => {
    const groupId = await addGroup();
    const from = await addMember(groupId);
    const to = await addMember(groupId);
    const closingId = await addClosing(groupId, from);
    const insert = (status: string, settledAt: number | null, carriedAt: number | null, by: string | null) =>
      run(
        `INSERT INTO settlement_transfers (id, group_id, closing_id, from_member_id, to_member_id, amount_minor,
           status, settled_at, carried_at, processed_by_member_id)
         VALUES (?, ?, ?, ?, ?, 13450, ?, ?, ?, ?)`,
        id('transfer'),
        groupId,
        closingId,
        from,
        to,
        status,
        settledAt,
        carriedAt,
        by,
      );
    await assert.rejects(insert('settled', null, null, from));
    await assert.rejects(insert('carried', 1, null, from));
    await insert('carried', null, 1, from);
  });

  it('users を消すと identities・sessions が消え、メンバーの user_id は NULL になる', async () => {
    const userId = await addUser();
    const identityId = id('identity');
    await run(
      `INSERT INTO identities (id, user_id, provider, sub, created_at, last_sign_in_at) VALUES (?, ?, 'apple', ?, 1, 1)`,
      identityId,
      userId,
      id('sub'),
    );
    await run(
      'INSERT INTO sessions (token_hash, identity_id, created_at, last_used_at) VALUES (?, ?, 1, 1)',
      id('hash'),
      identityId,
    );
    const groupId = await addGroup();
    const memberId = await addMember(groupId, userId);
    await run('DELETE FROM users WHERE id = ?', userId);
    const sessions = await db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE identity_id = ?')
      .bind(identityId)
      .first<{ n: number }>();
    assert.equal(sessions?.n, 0);
    const member = await db
      .prepare('SELECT user_id FROM group_members WHERE id = ?')
      .bind(memberId)
      .first<{ user_id: string | null }>();
    assert.equal(member?.user_id, null);
  });
});
