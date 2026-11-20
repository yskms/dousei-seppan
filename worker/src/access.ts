// APIの共通の権限判定（docs/backend-design.md 9章の末尾）: 認証、グループ所属、月の閲覧範囲、締め状態。
// 「IDを知っているだけで他グループのデータにアクセスできない」ようにするため、グループ内のデータを
// 扱うAPIは、必ずここを通す。Premiumの閲覧期間の制限（企画メモ10章）を入れるときは、`canViewMonth` に足す。
//
// 他グループのID・メンバーでない人・脱退済みの人は、区別せず「無い」（404）として扱う（IDの存在を教えない）。
import { monthIn } from './months.ts';
import { authenticateSession, sessionTokenFromRequest, type AuthenticatedSession } from './session.ts';

/** リクエストのセッションからユーザーを引く。無い・形が違う・期限切れなら null（401にする）。 */
export async function authenticateRequest(
  request: Request,
  db: D1Database,
  now: number,
): Promise<AuthenticatedSession | null> {
  const token = sessionTokenFromRequest(request);
  if (token === null) return null;
  return authenticateSession(db, token, now);
}

export interface GroupAccess {
  group: {
    id: string;
    currencyCode: string;
    currencyMinorUnit: number;
    timezone: string;
    createdAt: number;
  };
  /** 操作している本人のメンバー行。 */
  member: {
    id: string;
    /** `leaving` は、集計・締め・精算には参加でき、グループのデータも見られるが、支出は記録できない（5章）。 */
    status: 'active' | 'leaving';
    historyFromMonth: string;
    /** 「今月で脱退する」を選んだ月（脱退月）。選んでいなければ null。確定するまで `status` は `active` のまま。 */
    leaveRequestedMonth: string | null;
    /** 脱退が確定した月（脱退月）。確定していなければ null。 */
    expenseEndMonth: string | null;
  };
}

interface AccessRow {
  group_id: string;
  currency_code: string;
  currency_minor_unit: number;
  timezone: string;
  created_at: number;
  member_id: string;
  status: 'active' | 'leaving';
  history_from_month: string;
  leave_requested_month: string | null;
  expense_end_month: string | null;
}

/**
 * ユーザーがグループのデータを扱えるメンバー（`active`・`leaving`）なら、その情報を返す。
 * そうでなければ（グループが無い、メンバーでない、`left`・`deleted`）null。
 * 書き込みの前に呼ぶときは、先に `readDataVersion` で読んだバージョンのあとに呼ぶ（groupWrite.ts 冒頭の注意1）。
 */
export async function loadGroupAccess(db: D1Database, userId: string, groupId: string): Promise<GroupAccess | null> {
  const row = await db
    .prepare(
      `SELECT g.id AS group_id, g.currency_code AS currency_code, g.currency_minor_unit AS currency_minor_unit,
              g.timezone AS timezone, g.created_at AS created_at,
              m.id AS member_id, m.status AS status, m.history_from_month AS history_from_month,
              m.leave_requested_month AS leave_requested_month, m.expense_end_month AS expense_end_month
         FROM group_members m JOIN expense_groups g ON g.id = m.group_id
        WHERE m.group_id = ?1 AND m.user_id = ?2 AND m.status IN ('active', 'leaving')`,
    )
    .bind(groupId, userId)
    .first<AccessRow>();
  if (row === null) return null;
  return {
    group: {
      id: row.group_id,
      currencyCode: row.currency_code,
      currencyMinorUnit: row.currency_minor_unit,
      timezone: row.timezone,
      createdAt: row.created_at,
    },
    member: {
      id: row.member_id,
      status: row.status,
      historyFromMonth: row.history_from_month,
      leaveRequestedMonth: row.leave_requested_month,
      expenseEndMonth: row.expense_end_month,
    },
  };
}

/** その月のデータを見てよいか。新しいメンバーが見られるのは、参加（復帰）した月以降（5章）。 */
export function canViewMonth(access: GroupAccess, month: string): boolean {
  return month >= access.member.historyFromMonth;
}

/**
 * メンバーが、その月の集計に入る月か。参加（復帰）した月から、脱退月まで（脱退が確定していれば
 * `expenseEndMonth`、脱退を選んだだけなら `leaveRequestedMonth`）。`status` は見ない。削除したユーザーも、
 * 削除した月までは集計に含める（5章）。月締めを操作できるのも、この月のメンバー（4章）。
 */
export function participatesInMonth(
  member: { historyFromMonth: string; expenseEndMonth: string | null; leaveRequestedMonth: string | null },
  month: string,
): boolean {
  if (month < member.historyFromMonth) return false;
  const lastMonth = member.expenseEndMonth ?? member.leaveRequestedMonth;
  return lastMonth === null || month <= lastMonth;
}

/**
 * 脱退が確定したものとして扱うメンバーか。`leaving` はもちろん、脱退を選んだ月（`leaveRequestedMonth`）が終わった
 * `active` も含める。
 *
 * 脱退は「脱退月を締めたとき、または翌月1日」に確定するが、翌月1日の確定はCron（1時間ごと。競合すれば次の回）が
 * `status` を書く。確定を待たずに、脱退を選んだ月が終わったら、確定したものとして扱う（待つと、Cronが動くまでの間、
 * 脱退予定のメンバーが翌月の支出を記録したり、招待を発行したりできてしまう。5章）。
 */
export function isLeaveEffective(access: GroupAccess, now: number): boolean {
  return isLeaveEffectiveFor(access.member, access.group.timezone, now);
}

/**
 * `isLeaveEffective` の中身。`GroupAccess` を持たない呼び出し（招待の発行者が、まだ招待を発行できる状態か。invites.ts）が、
 * 同じ判定を使うための関数。確定の扱いを、経路ごとに書き写さない（`access.ts` を直したときに、ずれるため）。
 */
export function isLeaveEffectiveFor(
  member: { status: string; leaveRequestedMonth: string | null },
  timezone: string,
  now: number,
): boolean {
  if (member.status !== 'active') return true;
  return member.leaveRequestedMonth !== null && monthIn(timezone, now) > member.leaveRequestedMonth;
}

/** 支出を記録（登録・編集・削除）してよいか。脱退が確定したメンバーは記録できない（5章）。 */
export function canWriteExpenses(access: GroupAccess, now: number): boolean {
  return !isLeaveEffective(access, now);
}

/**
 * グループの設定（グループ名・通貨、費目、月ごとの負担割合）を変えてよいか。支出の記録と同じで、脱退が確定した
 * （確定したものとして扱う月の終わりを含む）メンバーは変えられない（5章）。全メンバーが変えられる（企画メモ4章）。
 */
export function canEditGroupSettings(access: GroupAccess, now: number): boolean {
  return !isLeaveEffective(access, now);
}

/** 招待を発行してよいか。`leaving` 以降（脱退が確定したものとして扱うメンバーを含む）は発行できない（5章「招待の取り消し」）。 */
export function canIssueInvites(access: GroupAccess, now: number): boolean {
  return canIssueInvitesFor(access.member, access.group.timezone, now);
}

/**
 * `canIssueInvites` の中身。`GroupAccess` を持たない呼び出し（グループ情報の `canInvite`。groups.ts）が、招待の発行と
 * **同じ**規則を使うための関数。発行の条件を足すときは、ここに足す（表示と実際の判定が食い違わない）。
 */
export function canIssueInvitesFor(
  member: { status: string; leaveRequestedMonth: string | null },
  timezone: string,
  now: number,
): boolean {
  return !isLeaveEffectiveFor(member, timezone, now);
}

/** 最後に締めた月。まだ締めていなければ null。 */
export async function latestClosedMonth(db: D1Database, groupId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT max(target_month) AS month FROM monthly_closings WHERE group_id = ?')
    .bind(groupId)
    .first<{ month: string | null }>();
  return row?.month ?? null;
}

export async function isMonthClosed(db: D1Database, groupId: string, month: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS found FROM monthly_closings WHERE group_id = ? AND target_month = ?')
    .bind(groupId, month)
    .first<{ found: number }>();
  return row !== null;
}
