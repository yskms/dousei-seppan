// APIのテスト用の、グループ・メンバー・セッションの組み立て。ローカルD1（test/localDatabase.ts）に直接書く。
// グループ・メンバー・費目を作るAPIは、まだ無い（9章の順に足す）ので、SQLで作る。
import { createHash, randomBytes } from 'node:crypto';

/** テストの「いま」: 2026-11-19 12:00（Asia/Tokyo）。 */
export const NOW = Date.UTC(2026, 10, 19, 3, 0, 0);
/** グループを作った時刻: 2026-10-05（Asia/Tokyo）。作成月は 2026-10。 */
export const GROUP_CREATED_AT = Date.UTC(2026, 9, 5, 3, 0, 0);

export interface Person {
  userId: string;
  memberId: string;
  /** セッションの値（Authorization: Bearer に入れる）。 */
  token: string;
}

export interface Fixture {
  groupId: string;
  /** 使える費目。 */
  categoryId: string;
  /** アーカイブ済みの費目。 */
  archivedCategoryId: string;
  /** 参加中。2026-10 から。 */
  alice: Person;
  /** 参加中。2026-10 から。 */
  bob: Person;
  /** 脱退が確定した（`leaving`）。脱退月は 2026-11。 */
  carol: Person;
  /** 参加中。2026-11 から（新しいメンバー）。 */
  newbie: Person;
  /** 脱退済み（`left`）。 */
  erin: Person;
  /** 削除したユーザー。ログインできない（セッションなし）。 */
  daveMemberId: string;
  /** どのグループのメンバーでもない人。 */
  outsider: Person;
  /** 別のグループ。 */
  other: { groupId: string; categoryId: string; member: Person };
}

let seq = 0;

export function createFixtureFactory(db: D1Database) {
  const insertUser = async (name: string): Promise<{ userId: string; token: string }> => {
    const n = ++seq;
    const userId = `user-${name}-${n}`;
    const identityId = `identity-${name}-${n}`;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('base64url');
    await db.batch([
      db.prepare('INSERT INTO users (id, created_at, last_active_at) VALUES (?, ?, ?)').bind(userId, NOW, NOW),
      db
        .prepare(
          `INSERT INTO identities (id, user_id, provider, sub, created_at, last_sign_in_at)
           VALUES (?, ?, 'google', ?, ?, ?)`,
        )
        .bind(identityId, userId, `sub-${name}-${n}`, NOW, NOW),
      db
        .prepare('INSERT INTO sessions (token_hash, identity_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
        .bind(tokenHash, identityId, NOW, NOW),
    ]);
    return { userId, token };
  };

  const insertGroup = async (name: string) => {
    const groupId = `group-${name}-${++seq}`;
    await db
      .prepare(
        `INSERT INTO expense_groups (id, name, currency_code, currency_minor_unit, timezone, created_at)
         VALUES (?, 'ふたりの生活費', 'JPY', 0, 'Asia/Tokyo', ?)`,
      )
      .bind(groupId, GROUP_CREATED_AT)
      .run();
    return groupId;
  };

  const insertMember = async (
    groupId: string,
    name: string,
    userId: string | null,
    options: { status?: string; historyFromMonth?: string; expenseEndMonth?: string | null } = {},
  ): Promise<string> => {
    // メンバーIDは「名前-番号」。名前の昇順がIDの昇順になる（端数を配る固定順をテストで読めるように）。
    const memberId = `${name}-${++seq}`;
    await db
      .prepare(
        `INSERT INTO group_members (id, group_id, user_id, display_name, color, status, history_from_month,
           expense_end_month, joined_at)
         VALUES (?, ?, ?, ?, 'pink', ?, ?, ?, ?)`,
      )
      .bind(
        memberId,
        groupId,
        userId,
        name,
        options.status ?? 'active',
        options.historyFromMonth ?? '2026-10',
        options.expenseEndMonth ?? null,
        GROUP_CREATED_AT,
      )
      .run();
    return memberId;
  };

  const insertCategory = async (groupId: string, name: string, archived = false): Promise<string> => {
    const categoryId = `category-${name}-${++seq}`;
    await db
      .prepare(
        `INSERT INTO categories (id, group_id, name, icon, color, archived_at, created_at)
         VALUES (?, ?, ?, 'cart', 'blue', ?, ?)`,
      )
      .bind(categoryId, groupId, name, archived ? NOW : null, GROUP_CREATED_AT)
      .run();
    return categoryId;
  };

  const personIn = async (
    groupId: string,
    name: string,
    options: Parameters<typeof insertMember>[3] = {},
  ): Promise<Person> => {
    const { userId, token } = await insertUser(name);
    return { userId, token, memberId: await insertMember(groupId, name, userId, options) };
  };

  return async function createFixture(): Promise<Fixture> {
    const groupId = await insertGroup('main');
    const alice = await personIn(groupId, 'alice');
    const bob = await personIn(groupId, 'bob');
    const carol = await personIn(groupId, 'carol', { status: 'leaving', expenseEndMonth: '2026-11' });
    const newbie = await personIn(groupId, 'newbie', { historyFromMonth: '2026-11' });
    const erin = await personIn(groupId, 'erin', { status: 'left', expenseEndMonth: '2026-10' });
    const daveMemberId = await insertMember(groupId, 'dave', null, { status: 'deleted', expenseEndMonth: '2026-10' });
    const categoryId = await insertCategory(groupId, 'food');
    const archivedCategoryId = await insertCategory(groupId, 'old', true);
    const outsider = { ...(await insertUser('outsider')), memberId: '' };

    const otherGroupId = await insertGroup('other');
    const otherMember = await personIn(otherGroupId, 'zed');
    const otherCategoryId = await insertCategory(otherGroupId, 'food');
    return {
      groupId,
      categoryId,
      archivedCategoryId,
      alice,
      bob,
      carol,
      newbie,
      erin,
      daveMemberId,
      outsider,
      other: { groupId: otherGroupId, categoryId: otherCategoryId, member: otherMember },
    };
  };
}

/** 月を締める（締めの中身は、支出のAPIの検査に要らないので、行だけを書く）。 */
export async function insertClosing(db: D1Database, groupId: string, month: string, closedByMemberId: string) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO monthly_closings (id, group_id, target_month, currency_code, currency_minor_unit,
           data_version, closed_by_member_id, closed_at)
         VALUES (?, ?, ?, 'JPY', 0, 1, ?, ?)`,
      )
      .bind(`closing-${month}-${++seq}`, groupId, month, closedByMemberId, NOW),
    db.prepare('UPDATE expense_groups SET data_version = data_version + 1 WHERE id = ?').bind(groupId),
  ]);
}
