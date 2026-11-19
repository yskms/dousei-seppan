// APIの共通の権限判定（docs/backend-design.md 9章の末尾）: 認証、グループ所属、月の閲覧範囲、締め状態。
// 「IDを知っているだけで他グループのデータにアクセスできない」ようにするため、グループ内のデータを
// 扱うAPIは、必ずここを通す。Premiumの閲覧期間の制限（企画メモ10章）を入れるときは、`canViewMonth` に足す。
//
// 他グループのID・メンバーでない人・脱退済みの人は、区別せず「無い」（404）として扱う（IDの存在を教えない）。
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
              m.id AS member_id, m.status AS status, m.history_from_month AS history_from_month
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
    member: { id: row.member_id, status: row.status, historyFromMonth: row.history_from_month },
  };
}

/** その月のデータを見てよいか。新しいメンバーが見られるのは、参加（復帰）した月以降（5章）。 */
export function canViewMonth(access: GroupAccess, month: string): boolean {
  return month >= access.member.historyFromMonth;
}

/** 支出を記録（登録・編集・削除）してよいか。脱退が確定したメンバー（`leaving`）は記録できない（5章）。 */
export function canWriteExpenses(access: GroupAccess): boolean {
  return access.member.status === 'active';
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
