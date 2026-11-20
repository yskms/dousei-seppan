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

export interface MemberOptions {
  status?: string;
  historyFromMonth?: string;
  leaveRequestedMonth?: string | null;
  expenseEndMonth?: string | null;
}

/** 月締め・精算の検査用の、小さなグループ。メンバーは名前で引く（`people.alice`）。 */
export interface SimpleGroup<Name extends string = string> {
  groupId: string;
  /** 使える費目（1つ）。 */
  categoryId: string;
  people: Record<Name, Person>;
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
    options: MemberOptions = {},
  ): Promise<string> => {
    // メンバーIDは「名前-番号」。名前の昇順がIDの昇順になる（端数を配る固定順をテストで読めるように）。
    const memberId = `${name}-${++seq}`;
    await db
      .prepare(
        `INSERT INTO group_members (id, group_id, user_id, display_name, color, status, history_from_month,
           leave_requested_month, expense_end_month, joined_at)
         VALUES (?, ?, ?, ?, 'pink', ?, ?, ?, ?, ?)`,
      )
      .bind(
        memberId,
        groupId,
        userId,
        name,
        options.status ?? 'active',
        options.historyFromMonth ?? '2026-10',
        options.leaveRequestedMonth ?? null,
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

  /** 指定した名前のメンバー（既定は2026-10から参加中）と、費目1つだけのグループ。作成月は2026-10。 */
  const createGroup = async <Name extends string>(
    names: readonly Name[],
    optionsByName: Partial<Record<Name, MemberOptions>> = {},
  ): Promise<SimpleGroup<Name>> => {
    const groupId = await insertGroup('simple');
    const people = {} as Record<Name, Person>;
    for (const name of names) people[name] = await personIn(groupId, name, optionsByName[name] ?? {});
    return { groupId, categoryId: await insertCategory(groupId, 'food'), people };
  };

  const createFixture = async function createFixture(): Promise<Fixture> {
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

  return Object.assign(createFixture, {
    createGroup,
    addCategory: insertCategory,
    /** 既存のグループに、メンバーの行を足す（`userId` が null ならログインできない）。 */
    addMember: insertMember,
    /** 既存のグループに、ログインできるメンバーを足す。 */
    addPerson: personIn,
    /** グループを作らずにユーザー（とセッション）だけ作る。 */
    addUser: async (name: string): Promise<Person> => ({ ...(await insertUser(name)), memberId: '' }),
  });
}

/** 割合の合計が10000になる均等割り。端数は、IDの昇順の先頭から1ずつ（2章）。 */
export const equalShares = (ids: readonly string[]): [string, number][] => {
  const base = Math.floor(10000 / ids.length);
  const rest = 10000 - base * ids.length;
  return [...ids].sort().map((id, index) => [id, base + (index < rest ? 1 : 0)]);
};

/** 費目のある月の割合と上限額（3章）。割合の合計は10000にすること（検査はしない）。 */
export async function insertCategoryRule(
  db: D1Database,
  groupId: string,
  categoryId: string,
  month: string,
  shares: readonly (readonly [memberId: string, basisPoints: number])[],
  cap: { memberId: string; capMinor: number } | null = null,
) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO category_month_settings (group_id, category_id, target_month, cap_member_id, cap_minor)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(groupId, categoryId, month, cap?.memberId ?? null, cap?.capMinor ?? null),
    ...shares.map(([memberId, basisPoints]) =>
      db
        .prepare(
          `INSERT INTO category_month_shares (group_id, category_id, target_month, member_id, share_basis_points)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(groupId, categoryId, month, memberId, basisPoints),
    ),
  ]);
}

/** 支出を直接書く（登録の検査は支出のAPIのテストで済んでいるので、集計の検査では行だけ作る）。 */
export async function insertExpenseRow(
  db: D1Database,
  expense: {
    groupId: string;
    categoryId: string;
    payerMemberId: string;
    amountMinor: number;
    targetMonth: string;
    /** 支出のID。無ければ `expense-<連番>`。登録の再送の検査は、UUIDのIDを指定する。 */
    id?: string;
    /** 登録した人。無ければ支払者。 */
    createdByMemberId?: string;
    /** `category` 以外のとき、メンバーごとの負担額（合計は金額と一致させること）。 */
    split?: { method: 'equal' | 'ratio' | 'fixed' | 'single'; allocations: readonly (readonly [string, number])[] };
  },
): Promise<string> {
  const id = expense.id ?? `expense-${++seq}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO expenses (id, group_id, expense_date, target_month, description, amount_minor, category_id,
           payer_member_id, created_by_member_id, split_method, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?10, ?8, ?9, ?9)`,
      )
      .bind(
        id,
        expense.groupId,
        `${expense.targetMonth}-15`,
        expense.targetMonth,
        expense.amountMinor,
        expense.categoryId,
        expense.payerMemberId,
        expense.split?.method ?? 'category',
        NOW,
        expense.createdByMemberId ?? expense.payerMemberId,
      ),
    ...(expense.split?.allocations ?? []).map(([memberId, burdenMinor]) =>
      db
        .prepare(
          `INSERT INTO expense_allocations (group_id, expense_id, member_id, burden_minor, share_basis_points)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .bind(expense.groupId, id, memberId, burdenMinor),
    ),
  ]);
  return id;
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

/** 招待を直接書く（発行のAPIの検査は invites.test.ts。ほかの検査では、行だけ作る）。`token` は平文の招待トークン。 */
export async function insertInviteRow(
  db: D1Database,
  invite: {
    groupId: string;
    invitedByMemberId: string;
    token?: string;
    expiresAt?: number;
    revokedAt?: number | null;
    consumed?: { memberId: string; at: number } | null;
  },
): Promise<{ id: string; token: string }> {
  const id = `invite-${++seq}`;
  const token = invite.token ?? randomBytes(32).toString('base64url');
  await db
    .prepare(
      `INSERT INTO invites (id, group_id, invited_by_member_id, token_hash, expires_at, consumed_at,
         consumed_by_member_id, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      invite.groupId,
      invite.invitedByMemberId,
      createHash('sha256').update(token).digest('base64url'),
      invite.expiresAt ?? NOW + 3 * 24 * 60 * 60 * 1000,
      invite.consumed?.at ?? null,
      invite.consumed?.memberId ?? null,
      invite.revokedAt ?? null,
      NOW,
    )
    .run();
  return { id, token };
}

/** 固定費のテンプレートを直接書く（固定費のAPIは、まだ無い）。 */
export async function insertRecurringRow(
  db: D1Database,
  recurring: {
    groupId: string;
    categoryId: string;
    payerMemberId: string;
    splitMethod?: 'category' | 'equal' | 'ratio' | 'fixed' | 'single';
    pausedReason?: 'member_changed' | 'payer_left' | 'manual' | null;
  },
): Promise<string> {
  const id = `recurring-${++seq}`;
  await db
    .prepare(
      `INSERT INTO recurring_expenses (id, group_id, description, amount_minor, category_id, payer_member_id,
         split_method, day_of_month, start_month, paused_at, paused_reason, created_at, updated_at)
       VALUES (?, ?, '家賃', 80000, ?, ?, ?, 25, '2026-10', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      recurring.groupId,
      recurring.categoryId,
      recurring.payerMemberId,
      recurring.splitMethod ?? 'category',
      recurring.pausedReason == null ? null : NOW,
      recurring.pausedReason ?? null,
      NOW,
      NOW,
    )
    .run();
  return id;
}
