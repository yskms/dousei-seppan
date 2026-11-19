// 締め済みの月の読み取りと、送金まわりの共通部分（月締め closings.ts と、精算・繰越 transfers.ts が使う）。
// 形は docs/backend-design.md 9章「月締め・精算API」。
import { GROUP_WRITE_GUARD } from './groupWrite.ts';

export type TransferStatus = 'pending' | 'settled' | 'carried';

export interface TransferRow {
  id: string;
  from_member_id: string;
  to_member_id: string;
  amount_minor: number;
  status: TransferStatus;
  settled_at: number | null;
  carried_at: number | null;
  processed_by_member_id: string | null;
}

export const TRANSFER_COLUMNS = `id, from_member_id, to_member_id, amount_minor, status, settled_at, carried_at,
  processed_by_member_id`;

/**
 * 繰り越せるメンバーか（4章「精算と繰越」）。脱退を選んだメンバー（`leave_requested_month` あり）、脱退が確定した
 * （`leaving`）・脱退済み・削除したメンバーが送金元・送金先のどちらかである送金は、繰り越せない（精算済みにするしかない）。
 */
export function isCarryableMember(member: { status: string; leaveRequestedMonth: string | null }): boolean {
  return member.status === 'active' && member.leaveRequestedMonth === null;
}

export function transferJson(row: TransferRow, canCarry: boolean) {
  return {
    id: row.id,
    fromMemberId: row.from_member_id,
    toMemberId: row.to_member_id,
    amountMinor: row.amount_minor,
    status: row.status,
    settledAt: row.settled_at,
    carriedAt: row.carried_at,
    processedByMemberId: row.processed_by_member_id,
    // 未処理で、両方のメンバーが繰り越せるときだけ true。アプリが規則を持たなくて済むように返す。
    canCarry: row.status === 'pending' && canCarry,
  };
}

/**
 * 脱退が確定した（`leaving`）メンバーを、脱退済み（`left`）にする文（5章「脱退」の4）。
 * 脱退月が締められ、そのメンバーが関わる未処理（pending）の送金が無いときだけ変わる。月締め（送金が0件なら、
 * 締めた時点で脱退済み）と、精算の処理の中で呼ぶ。`memberIds` を渡せば、そのメンバーだけが対象。
 * 繰越済み（carried）の送金は、翌月の精算に合算済みなので、未処理に数えない。
 * GROUP_WRITE_GUARD の条件つき（8章）。
 */
export function markLeftStatement(
  db: D1Database,
  token: string,
  groupId: string,
  now: number,
  memberIds: readonly string[] | null,
): D1PreparedStatement {
  const idFilter = memberIds === null ? '' : `AND id IN (${memberIds.map(() => '?').join(', ')})`;
  return db
    .prepare(
      `UPDATE group_members SET status = 'left', left_at = ?
        WHERE group_id = ? AND status = 'leaving' ${idFilter}
          AND EXISTS (SELECT 1 FROM monthly_closings c
                       WHERE c.group_id = group_members.group_id AND c.target_month = group_members.expense_end_month)
          AND NOT EXISTS (SELECT 1 FROM settlement_transfers t
                           WHERE t.group_id = group_members.group_id AND t.status = 'pending'
                             AND (t.from_member_id = group_members.id OR t.to_member_id = group_members.id))
          AND EXISTS (${GROUP_WRITE_GUARD})`,
    )
    .bind(now, groupId, ...(memberIds ?? []), groupId, token);
}

/** 締め済みの月の、締めた時点の集計と、送金（状態つき）。`GET .../closing` と、締めた月の `summary` が返す。 */
export interface ClosedMonthView {
  month: string;
  closed: true;
  closing: { id: string; closedAt: number; closedByMemberId: string; processed: boolean };
  /** その月の支出の総額（繰越を含めない）。 */
  totalMinor: number;
  members: {
    memberId: string;
    displayName: string;
    paidMinor: number;
    burdenMinor: number;
    differenceMinor: number;
    carriedInMinor: number;
    netMinor: number;
  }[];
  categories: { categoryId: string; totalMinor: number; burdens: { memberId: string; burdenMinor: number }[] }[];
  transfers: ReturnType<typeof transferJson>[];
}

/** 締めの記録を1回の batch（同じ時点）で読む。締めが無ければ（別のグループのIDを含む）null。 */
export async function loadClosedMonth(
  db: D1Database,
  groupId: string,
  closingId: string,
): Promise<ClosedMonthView | null> {
  const [closing, summaries, burdens, transfers, members] = await db.batch([
    db
      .prepare(
        'SELECT target_month, closed_by_member_id, closed_at FROM monthly_closings WHERE id = ?1 AND group_id = ?2',
      )
      .bind(closingId, groupId),
    db
      .prepare(
        `SELECT member_id, display_name_snapshot, paid_minor, burden_minor, difference_minor, carried_in_minor, net_minor
           FROM closing_member_summaries WHERE closing_id = ?1 AND group_id = ?2 ORDER BY member_id`,
      )
      .bind(closingId, groupId),
    db
      .prepare(
        `SELECT category_id, member_id, total_minor, burden_minor FROM closing_category_burdens
          WHERE closing_id = ?1 AND group_id = ?2 ORDER BY category_id, member_id`,
      )
      .bind(closingId, groupId),
    db
      .prepare(
        `SELECT ${TRANSFER_COLUMNS} FROM settlement_transfers
          WHERE closing_id = ?1 AND group_id = ?2 ORDER BY from_member_id, to_member_id`,
      )
      .bind(closingId, groupId),
    db.prepare('SELECT id, status, leave_requested_month FROM group_members WHERE group_id = ?').bind(groupId),
  ]);
  const closingRow = closing.results[0] as
    | { target_month: string; closed_by_member_id: string; closed_at: number }
    | undefined;
  if (closingRow === undefined) return null;

  const carryable = new Map(
    (members.results as { id: string; status: string; leave_requested_month: string | null }[]).map((row) => [
      row.id,
      isCarryableMember({ status: row.status, leaveRequestedMonth: row.leave_requested_month }),
    ]),
  );
  const transferRows = transfers.results as unknown as TransferRow[];
  const memberRows = (
    summaries.results as {
      member_id: string;
      display_name_snapshot: string;
      paid_minor: number;
      burden_minor: number;
      difference_minor: number;
      carried_in_minor: number;
      net_minor: number;
    }[]
  ).map((row) => ({
    memberId: row.member_id,
    displayName: row.display_name_snapshot,
    paidMinor: row.paid_minor,
    burdenMinor: row.burden_minor,
    differenceMinor: row.difference_minor,
    carriedInMinor: row.carried_in_minor,
    netMinor: row.net_minor,
  }));

  const categories = new Map<string, ClosedMonthView['categories'][number]>();
  for (const row of burdens.results as {
    category_id: string;
    member_id: string;
    total_minor: number;
    burden_minor: number;
  }[]) {
    let category = categories.get(row.category_id);
    if (category === undefined) {
      category = { categoryId: row.category_id, totalMinor: row.total_minor, burdens: [] };
      categories.set(row.category_id, category);
    }
    category.burdens.push({ memberId: row.member_id, burdenMinor: row.burden_minor });
  }

  return {
    month: closingRow.target_month,
    closed: true,
    closing: {
      id: closingId,
      closedAt: closingRow.closed_at,
      closedByMemberId: closingRow.closed_by_member_id,
      // 全部の送金が settled か carried。送金が0件の月も処理済み（4章）。
      processed: transferRows.every((row) => row.status !== 'pending'),
    },
    totalMinor: memberRows.reduce((sum, row) => sum + row.paidMinor, 0),
    members: memberRows,
    categories: [...categories.values()],
    transfers: transferRows.map((row) =>
      transferJson(row, (carryable.get(row.from_member_id) ?? false) && (carryable.get(row.to_member_id) ?? false)),
    ),
  };
}
