// アカウント削除のデータ処理（匿名化）。規則は docs/backend-design.md 5章「アカウント削除」、競合制御は8章。
//
// これは、`POST /auth/delete`（セッションと再認証の確認、Appleのrevoke。認証のコードで、まだ無い。12章）が、再認証に
// 成功したあとで呼ぶ処理。月単位の脱退の規則によらず、すべてのグループからすぐに抜け、最後に `users` の行を消す。
// すべてを、1回の `batch()`（`writeToGroups`。関わるグループすべてのバージョンが、読んだときのままのときだけ）で行う。
//
// グループごとに、次のどちらか（自分のメンバー行は、過去に脱退したものを含む）。
// - 自分以外に、参加中・脱退が確定した（`leaving`）メンバーがいない: グループのデータをすべて消す。
// - 残るメンバーがいる: 自分の行を `deleted`・「削除されたユーザー」・`user_id = NULL` にし、締めた月の表示名のスナップ
//   ショットも匿名化する。参加中だった（`active`）なら、さらに、`expense_end_month` を今月（脱退を選んだ月が終わって
//   いればその月）にし、翌月の全費目の割合を残るメンバーでの均等にリセットし、発行した未使用の招待を取り消し、固定費を止める。
//
// 書き込みの前に、先にバージョンを読み、そのあとでデータを読む（groupWrite.ts 冒頭の注意1）。
// 「どのグループのメンバーか」を、バージョンより前に読むので、読んだあとに新しいグループへ参加されると、そのグループが
// 抜ける。それを検出するため、書き込みの条件に「いまのメンバー行が、読んだグループの中だけ」を足している。
import { GROUP_WRITE_GUARD, writeToGroups } from './groupWrite.ts';
import {
  DELETED_USER_NAME,
  deleteGroupChildrenStatements,
  deleteGroupRowStatement,
  loadCategoryIds,
  loadMembers,
  participantIds,
  pauseRecurringStatements,
  resetSharesStatements,
  revokeInvitesStatement,
} from './membership.ts';
import { monthIn, nextMonth } from './months.ts';

export type DeleteAccountResult =
  | { status: 'deleted'; deletedGroups: number; anonymizedGroups: number }
  /** 他の書き込みと競合し続けた（何も変更していない）。もう一度呼べる。 */
  | { status: 'conflict' };

interface GroupPlan {
  groupId: string;
  version: number;
  timezone: string;
  memberId: string;
  members: Awaited<ReturnType<typeof loadMembers>>;
  categoryIds: string[];
  /** 残るメンバーがいないので、グループごと消す。 */
  deletesGroup: boolean;
}

/** 1回の試行。`null` は、読んだ状態が合わなかった（やり直す）。 */
async function attempt(db: D1Database, userId: string, now: number): Promise<DeleteAccountResult | null> {
  const { results: memberships } = await db
    .prepare('SELECT id AS member_id, group_id FROM group_members WHERE user_id = ? ORDER BY group_id')
    .bind(userId)
    .all<{ member_id: string; group_id: string }>();

  if (memberships.length === 0) {
    // グループが無ければ、書くバージョンも無い。読んだあとに参加されていたら、消さずにやり直す。
    const removed = await db
      .prepare('DELETE FROM users WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM group_members WHERE user_id = ?1)')
      .bind(userId)
      .run();
    if (removed.meta.changes === 1) return { status: 'deleted', deletedGroups: 0, anonymizedGroups: 0 };
    const stillThere = await db.prepare('SELECT 1 AS found FROM users WHERE id = ?').bind(userId).first<{ found: number }>();
    // すでに消えている（二重に呼ばれた）なら、削除済み。
    return stillThere === null ? { status: 'deleted', deletedGroups: 0, anonymizedGroups: 0 } : null;
  }

  const groupIds = memberships.map((row) => row.group_id);
  const groupIdsJson = JSON.stringify(groupIds);

  // バージョンが先。そのあとで、メンバー・費目のデータを読む。
  const { results: versionRows } = await db
    .prepare('SELECT id, data_version, timezone FROM expense_groups WHERE id IN (SELECT value FROM json_each(?))')
    .bind(groupIdsJson)
    .all<{ id: string; data_version: number; timezone: string }>();
  if (versionRows.length !== groupIds.length) return null; // 読んでいる間に、グループが消えた。
  const versions = new Map(versionRows.map((row) => [row.id, row]));

  const plans: GroupPlan[] = [];
  for (const membership of memberships) {
    const group = versions.get(membership.group_id)!;
    const members = await loadMembers(db, membership.group_id);
    plans.push({
      groupId: membership.group_id,
      version: group.data_version,
      timezone: group.timezone,
      memberId: membership.member_id,
      members,
      categoryIds: await loadCategoryIds(db, membership.group_id),
      deletesGroup: members.every(
        (member) => member.id === membership.member_id || (member.status !== 'active' && member.status !== 'leaving'),
      ),
    });
  }

  const written = await writeToGroups(
    db,
    plans.map((plan) => ({ groupId: plan.groupId, expectedVersion: plan.version })),
    (token) => {
      const statements: D1PreparedStatement[] = [];
      const groupRows: D1PreparedStatement[] = [];
      for (const plan of plans) {
        if (plan.deletesGroup) {
          statements.push(...deleteGroupChildrenStatements(db, token, plan.groupId));
          // グループの行の削除は、ほかの文の最後にまとめる（writeToGroups の注意）。
          groupRows.push(deleteGroupRowStatement(db, token, plan.groupId));
        } else {
          statements.push(...anonymizeStatements(db, token, userId, now, plan));
        }
      }
      // 最後に users を消す（identities・sessions は ON DELETE CASCADE で消える）。全グループのバージョンが、
      // 一度に上がったときだけ token が書かれるので、1つ目のグループの条件で足りる。
      statements.push(
        db
          .prepare(`DELETE FROM users WHERE id = ? AND EXISTS (${GROUP_WRITE_GUARD})`)
          .bind(userId, plans[0]!.groupId, token),
      );
      return [...statements, ...groupRows];
    },
    {
      sql: 'NOT EXISTS (SELECT 1 FROM group_members WHERE user_id = ? AND group_id NOT IN (SELECT value FROM json_each(?)))',
      bindings: [userId, groupIdsJson],
    },
  );
  if (!written.ok) {
    if (written.reason === 'unique') throw new Error('アカウント削除で、想定外の一意制約違反');
    return null;
  }
  const deletedGroups = plans.filter((plan) => plan.deletesGroup).length;
  return { status: 'deleted', deletedGroups, anonymizedGroups: plans.length - deletedGroups };
}

/** 残るメンバーがいるグループでの、自分の匿名化と、それにともなう書き込み。 */
function anonymizeStatements(
  db: D1Database,
  token: string,
  userId: string,
  now: number,
  plan: GroupPlan,
): D1PreparedStatement[] {
  const me = plan.members.find((member) => member.id === plan.memberId)!;
  // 参加中だったグループでは、集計に入る最後の月を、今月にする。脱退を選んだ月がすでに終わっていれば、その月（Cronの確定を
  // 待たずに、確定したものとして扱う。access.ts の `isLeaveEffective`）。脱退が確定した・脱退済みの人は、そのまま。
  const currentMonth = monthIn(plan.timezone, now);
  const endMonth =
    me.status === 'active'
      ? me.leaveRequestedMonth !== null && me.leaveRequestedMonth < currentMonth
        ? me.leaveRequestedMonth
        : currentMonth
      : me.expenseEndMonth;

  const statements = [
    db
      .prepare(
        `UPDATE group_members SET status = 'deleted', display_name = ?, user_id = NULL, expense_end_month = ?
          WHERE id = ? AND group_id = ? AND user_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`,
      )
      .bind(DELETED_USER_NAME, endMonth, plan.memberId, plan.groupId, userId, plan.groupId, token),
    // 締めた月の、表示名のスナップショットも匿名化する。
    db
      .prepare(
        `UPDATE closing_member_summaries SET display_name_snapshot = ?
          WHERE group_id = ? AND member_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`,
      )
      .bind(DELETED_USER_NAME, plan.groupId, plan.memberId, plan.groupId, token),
  ];
  // 脱退が確定した・脱退済みの人は、確定のときに、割合のリセット・招待の取り消し・固定費の停止を済ませている。
  if (me.status === 'active') {
    const resetMonth = nextMonth(endMonth!);
    const after = plan.members.map((member) =>
      member.id === plan.memberId
        ? { ...member, status: 'deleted' as const, displayName: DELETED_USER_NAME, expenseEndMonth: endMonth }
        : member,
    );
    statements.push(
      ...resetSharesStatements(db, token, plan.groupId, resetMonth, plan.categoryIds, participantIds(after, resetMonth)),
      ...revokeInvitesStatement(db, token, plan.groupId, now, [plan.memberId]),
      ...pauseRecurringStatements(db, token, plan.groupId, now, { payerMemberIds: [plan.memberId], memberChanged: true }),
    );
  }
  return statements;
}

/**
 * アカウントのデータを匿名化・削除する（`users` の行まで）。競合したら、読み直して数回までやり直す。
 * 認証（再認証・Appleのrevoke）は、呼び出し側が先に済ませる。
 */
export async function deleteAccount(
  db: D1Database,
  userId: string,
  now: number,
  maxAttempts = 3,
): Promise<DeleteAccountResult> {
  for (let tried = 0; tried < maxAttempts; tried++) {
    const result = await attempt(db, userId, now);
    if (result !== null) return result;
  }
  return { status: 'conflict' };
}
