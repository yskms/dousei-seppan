// メンバーの増減にともなう書き込みの共通部分（参加・脱退の確定・グループの削除）。規則は
// docs/backend-design.md 5章。月締め（closings.ts）・脱退を選ぶ操作（leave.ts）・月初のCron（cron.ts）・
// 参加（invites.ts）が同じ関数を使う（脱退の確定を、経路ごとに別々に書くと、確定の中身がずれるため）。
//
// ここの `...Statements` は、どれも GROUP_WRITE_GUARD の条件つき（8章）。`writeToGroup` の build の中で呼ぶ。
// 読み込み（`loadMembers`・`loadCategoryIds`）は、バージョンを読んだあとに呼ぶ（groupWrite.ts 冒頭の注意1）。
import { participatesInMonth } from './access.ts';
import { GROUP_WRITE_GUARD, insertRowsGuarded } from './groupWrite.ts';
import type { MemberInfo } from './monthState.ts';
import { nextMonth } from './months.ts';
import { allocateEqually, BASIS_POINTS_TOTAL } from './settlement.ts';

/** アカウントを削除したメンバーの表示名（5章「アカウント削除」）。 */
export const DELETED_USER_NAME = '削除されたユーザー';

/**
 * メンバーのアイコンの色のキー（`group_members.color`）。アプリの色の一覧と、このキーで揃える
 * （docs/backend-design.md 9章。アプリとはコードを共有しない）。画面設計メモの「10色ほど」の、仮の一覧。
 */
export const MEMBER_COLORS = ['pink', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'brown', 'gray'] as const;

/**
 * 参加したメンバーの色を、他のメンバーと重ならないように選ぶ（画面設計メモ「グループの設定」）。`preferred`（復帰する
 * 人の元の色）が使われていなければ、それを使う。全色が使われていれば、使われている数で一巡させる。
 */
export function pickMemberColor(usedColors: readonly string[], preferred: string | null = null): string {
  if (preferred !== null && !usedColors.includes(preferred)) return preferred;
  return MEMBER_COLORS.find((color) => !usedColors.includes(color)) ?? MEMBER_COLORS[usedColors.length % MEMBER_COLORS.length]!;
}

/** グループの全メンバー（脱退済み・削除済みを含む）。 */
export async function loadMembers(db: D1Database, groupId: string): Promise<MemberInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT id, display_name, status, history_from_month, expense_end_month, leave_requested_month
         FROM group_members WHERE group_id = ?`,
    )
    .bind(groupId)
    .all<{
      id: string;
      display_name: string;
      status: MemberInfo['status'];
      history_from_month: string;
      expense_end_month: string | null;
      leave_requested_month: string | null;
    }>();
  return results.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    historyFromMonth: row.history_from_month,
    expenseEndMonth: row.expense_end_month,
    leaveRequestedMonth: row.leave_requested_month,
  }));
}

/** グループの全費目のID（アーカイブ済みも含む）。 */
export async function loadCategoryIds(db: D1Database, groupId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM categories WHERE group_id = ? ORDER BY id')
    .bind(groupId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** その月の集計に入るメンバーのID（参加（復帰）した月から、脱退月まで。`status` は見ない）。 */
export function participantIds(members: readonly MemberInfo[], month: string): string[] {
  return members.filter((member) => participatesInMonth(member, month)).map((member) => member.id);
}

/**
 * 月の全費目の負担割合を、`memberIds` での均等にリセットし、上限額の設定も外す（5章。メンバーが増減したとき）。
 * その月の既存の行は消して書き直す。端数は、IDの昇順の先頭から1ずつ（2章）。
 *
 * **締めた月には使わない**（締めた月の割合は確定している）。呼び出し側が、未締めの月を渡す。
 * 費目はアーカイブ済みも含めて全部書く（あとで戻された費目が、古い割合に戻らないように）。
 * メンバーが0人なら何もしない（その月を使う人がいない）。
 */
export function resetSharesStatements(
  db: D1Database,
  token: string,
  groupId: string,
  month: string,
  categoryIds: readonly string[],
  memberIds: readonly string[],
): D1PreparedStatement[] {
  if (memberIds.length === 0 || categoryIds.length === 0) return [];
  const shares = allocateEqually(BASIS_POINTS_TOTAL, memberIds);
  const remove = (table: string) =>
    db
      .prepare(`DELETE FROM ${table} WHERE group_id = ? AND target_month = ? AND EXISTS (${GROUP_WRITE_GUARD})`)
      .bind(groupId, month, groupId, token);
  return [
    remove('category_month_shares'),
    remove('category_month_settings'),
    ...insertRowsGuarded(
      db,
      token,
      groupId,
      'category_month_settings',
      ['group_id', 'category_id', 'target_month', 'cap_member_id', 'cap_minor'],
      categoryIds.map((categoryId) => [groupId, categoryId, month, null, null]),
    ),
    ...insertRowsGuarded(
      db,
      token,
      groupId,
      'category_month_shares',
      ['group_id', 'category_id', 'target_month', 'member_id', 'share_basis_points'],
      categoryIds.flatMap((categoryId) =>
        shares.map((share) => [groupId, categoryId, month, share.memberId, share.amount]),
      ),
    ),
  ];
}

/**
 * 固定費の自動登録を止める（5章）。すでに止まっているもの（手動の停止など）は、理由を上書きしない。
 * - `payerMemberIds` が支払者の固定費: `payer_left`（付け替えられていないもの）。
 * - `memberChanged`: `category` 以外の負担方法の固定費は `member_changed`（個別の負担が、メンバーの増減で
 *   合わなくなる）。支払者が対象のものは、先に `payer_left` で止まっている。
 * 止めた固定費を再開するときは、そのAPIが、支払者・負担の対象が今のメンバーで有効かを確かめる。
 */
export function pauseRecurringStatements(
  db: D1Database,
  token: string,
  groupId: string,
  now: number,
  options: { payerMemberIds: readonly string[]; memberChanged: boolean },
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (options.payerMemberIds.length > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE recurring_expenses SET paused_at = ?, paused_reason = 'payer_left', updated_at = ?
            WHERE group_id = ? AND paused_at IS NULL AND payer_member_id IN (${options.payerMemberIds.map(() => '?').join(', ')})
              AND EXISTS (${GROUP_WRITE_GUARD})`,
        )
        .bind(now, now, groupId, ...options.payerMemberIds, groupId, token),
    );
  }
  if (options.memberChanged) {
    statements.push(
      db
        .prepare(
          `UPDATE recurring_expenses SET paused_at = ?, paused_reason = 'member_changed', updated_at = ?
            WHERE group_id = ? AND paused_at IS NULL AND split_method <> 'category' AND EXISTS (${GROUP_WRITE_GUARD})`,
        )
        .bind(now, now, groupId, groupId, token),
    );
  }
  return statements;
}

/** `memberIds` が発行した、未使用（使われていない・取り消されていない）の招待をすべて取り消す。期限切れも取り消す。 */
export function revokeInvitesStatement(
  db: D1Database,
  token: string,
  groupId: string,
  now: number,
  memberIds: readonly string[],
): D1PreparedStatement[] {
  if (memberIds.length === 0) return [];
  return [
    db
      .prepare(
        `UPDATE invites SET revoked_at = ?
          WHERE group_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
            AND invited_by_member_id IN (${memberIds.map(() => '?').join(', ')}) AND EXISTS (${GROUP_WRITE_GUARD})`,
      )
      .bind(now, groupId, ...memberIds, groupId, token),
  ];
}

/**
 * 脱退を確定させる対象（5章「脱退」の2）。`throughMonth` 以前を脱退月に選んだままの、参加中（`active`）のメンバー。
 * 月締めは、締める月を渡す。Cronは、グループの今月より前の月を渡す（月が終わったもの）。
 */
export function dueLeaves(members: readonly MemberInfo[], throughMonth: string): MemberInfo[] {
  return members.filter(
    (member) =>
      member.status === 'active' && member.leaveRequestedMonth !== null && member.leaveRequestedMonth <= throughMonth,
  );
}

/**
 * 確定する脱退者が、グループの最後の1人か。参加中・脱退が確定した（`leaving`）メンバーが、その1人だけのとき。
 * 2人以上が同時に抜けるときは、お互いの精算が残るので、グループは消さない（全員が脱退済みになったグループの
 * 後片付けは、docs/backend-design.md 12章）。
 */
export function isLastMember(members: readonly MemberInfo[], due: readonly MemberInfo[]): boolean {
  const remaining = members.filter((member) => member.status === 'active' || member.status === 'leaving');
  return due.length === 1 && remaining.length === 1 && remaining[0]!.id === due[0]!.id;
}

/**
 * 脱退の確定の書き込み（5章「脱退」の2）。`due` は、`dueLeaves` で選んだメンバー。最後の1人のときは使わず、
 * `deleteGroupStatements` で、グループごと消す。
 * - `expense_end_month` に脱退月を入れ、`status` を `leaving` にする。
 * - 脱退月の翌月の全費目の割合を、残るメンバーでの均等にリセットする（`members` は、確定前の状態）。
 * - 発行した未使用の招待を取り消す。
 * - 脱退者が支払者の固定費と、`category` 以外の固定費の自動登録を止める。
 * 脱退済み（`left`）への遷移は含まない。呼び出し側が、`markLeftStatement`（closedMonth.ts）を、これの後ろに足す。
 */
export function confirmLeaveStatements(
  db: D1Database,
  token: string,
  groupId: string,
  now: number,
  members: readonly MemberInfo[],
  due: readonly MemberInfo[],
  categoryIds: readonly string[],
): D1PreparedStatement[] {
  if (due.length === 0) return [];
  const dueIds = due.map((member) => member.id);
  const resetMonths = new Set(due.map((member) => nextMonth(member.leaveRequestedMonth!)));
  return [
    db
      .prepare(
        `UPDATE group_members SET status = 'leaving', expense_end_month = leave_requested_month
          WHERE group_id = ? AND status = 'active' AND leave_requested_month IS NOT NULL
            AND id IN (${dueIds.map(() => '?').join(', ')}) AND EXISTS (${GROUP_WRITE_GUARD})`,
      )
      .bind(groupId, ...dueIds, groupId, token),
    // 脱退月の翌月に参加しているのは、脱退を選んだメンバーを除く、そのとき参加している全員。
    ...[...resetMonths].sort().flatMap((month) =>
      resetSharesStatements(db, token, groupId, month, categoryIds, participantIds(members, month)),
    ),
    ...revokeInvitesStatement(db, token, groupId, now, dueIds),
    ...pauseRecurringStatements(db, token, groupId, now, { payerMemberIds: dueIds, memberChanged: true }),
  ];
}

/**
 * グループのデータをすべて物理削除する文（5章「グループの削除」）。外部キーに `ON DELETE CASCADE` を付けていない
 * ので、子から順に消す。最後の `expense_groups` の削除は、トークンの一致を条件にする。
 */
export function deleteGroupStatements(db: D1Database, token: string, groupId: string): D1PreparedStatement[] {
  const children = [
    'settlement_transfers',
    'closing_category_burdens',
    'closing_member_summaries',
    'monthly_closings',
    'expense_allocations',
    'expenses',
    'recurring_expense_runs',
    'recurring_expense_allocations',
    'recurring_expenses',
    'category_month_shares',
    'category_month_settings',
    'categories',
    'invites',
    'group_members',
  ];
  return [
    ...children.map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE group_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`).bind(groupId, groupId, token),
    ),
    db.prepare('DELETE FROM expense_groups WHERE id = ? AND write_token = ?').bind(groupId, token),
  ];
}
