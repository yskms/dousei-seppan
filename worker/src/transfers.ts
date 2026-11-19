// 送金の精算済み・繰越。規則は docs/backend-design.md 4章「精算と繰越」、形は9章「月締め・精算API」。
//
// - 許可する状態遷移は `pending → settled` と `pending → carried` だけ。確定後に戻せない。
// - 脱退を選んだメンバー・脱退が確定した（`leaving`）メンバー・削除したメンバーが関わる送金は、繰り越せない。
// - 精算も繰越も、全メンバー（`active`・`leaving`）が操作できる。
// - やり直さずに、競合したら409を返す（8章。操作の直前の確認の内容が変わりうるため）。
//   バージョンを先に読み、そのあとで、権限・送金のデータを読む（groupWrite.ts 冒頭の注意1）。
import { authenticateRequest, canViewMonth, loadGroupAccess } from './access.ts';
import { isCarryableMember, markLeftStatement, transferJson, type TransferRow } from './closedMonth.ts';
import { GROUP_WRITE_GUARD, readDataVersion, writeToGroup } from './groupWrite.ts';
import { conflict, json, notFound, unauthorized } from './http.ts';

export type TransferAction = 'settle' | 'carry';

/** 送金の属するグループ。無ければ null。権限の確認は、このあと groupId で行う（IDだけでは何も見せない）。 */
async function findTransferGroup(db: D1Database, transferId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT group_id FROM settlement_transfers WHERE id = ?')
    .bind(transferId)
    .first<{ group_id: string }>();
  return row === null ? null : row.group_id;
}

function updateTransferStatement(
  db: D1Database,
  token: string,
  groupId: string,
  transferId: string,
  action: TransferAction,
  now: number,
  memberId: string,
): D1PreparedStatement {
  // `AND status = 'pending'` で、状態が pending からしか変わらないようにする（付録A-7）。
  const set = action === 'settle' ? 'status = ?, settled_at = ?' : 'status = ?, carried_at = ?';
  return db
    .prepare(
      `UPDATE settlement_transfers SET ${set}, processed_by_member_id = ?
        WHERE id = ? AND group_id = ? AND status = 'pending' AND EXISTS (${GROUP_WRITE_GUARD})`,
    )
    .bind(action === 'settle' ? 'settled' : 'carried', now, memberId, transferId, groupId, groupId, token);
}

// ---------------------------------------------------------------------------
// POST /transfers/:id/settle、POST /transfers/:id/carry

export async function handleProcessTransfer(
  request: Request,
  env: Env,
  now: number,
  transferId: string,
  action: TransferAction,
): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();
  const db = env.DB;

  const groupId = await findTransferGroup(db, transferId);
  if (groupId === null) return notFound();

  // バージョンが先。そのあとで、権限・送金のデータを読む。
  const version = await readDataVersion(db, groupId);
  if (version === null) return notFound();
  const access = await loadGroupAccess(db, session.userId, groupId);
  if (access === null) return notFound();

  const [transfer, members] = await db.batch([
    db
      .prepare(
        `SELECT t.id, t.from_member_id, t.to_member_id, t.amount_minor, t.status, t.settled_at, t.carried_at,
                t.processed_by_member_id, c.target_month AS target_month
           FROM settlement_transfers t JOIN monthly_closings c ON c.id = t.closing_id AND c.group_id = t.group_id
          WHERE t.id = ?1 AND t.group_id = ?2`,
      )
      .bind(transferId, groupId),
    db.prepare('SELECT id, status, leave_requested_month FROM group_members WHERE group_id = ?').bind(groupId),
  ]);
  const row = transfer.results[0] as (TransferRow & { target_month: string }) | undefined;
  // 参加前の月の送金は、無いものとして扱う（5章。IDの存在を教えない）。
  if (row === undefined || !canViewMonth(access, row.target_month)) return notFound();

  if (row.status !== 'pending') return conflict('transfer_not_pending', { status: row.status });

  if (action === 'carry') {
    const memberStatus = new Map(
      (members.results as { id: string; status: string; leave_requested_month: string | null }[]).map((member) => [
        member.id,
        { status: member.status, leaveRequestedMonth: member.leave_requested_month },
      ]),
    );
    const from = memberStatus.get(row.from_member_id);
    const to = memberStatus.get(row.to_member_id);
    if (from === undefined || to === undefined || !isCarryableMember(from) || !isCarryableMember(to)) {
      return conflict('transfer_not_carryable');
    }
  }

  const written = await writeToGroup(db, groupId, version, (token) => [
    updateTransferStatement(db, token, groupId, transferId, action, now, access.member.id),
    // 精算済みにした結果、脱退が確定したメンバーの未処理の送金が無くなれば、脱退済みにする（5章）。
    ...(action === 'settle' ? [markLeftStatement(db, token, groupId, now, [row.from_member_id, row.to_member_id])] : []),
  ]);
  if (!written.ok) return conflict('conflict');
  // 上の判定は、バージョンを読んだあとの状態に対するもの。バージョンが合っていれば、更新は必ず1件に効く。
  // 0件なら、その前提が崩れている（実装の誤り）ので、成功にしない。
  if (written.results[0]?.meta.changes !== 1) return conflict('conflict');

  const processed: TransferRow = {
    ...row,
    status: action === 'settle' ? 'settled' : 'carried',
    settled_at: action === 'settle' ? now : null,
    carried_at: action === 'carry' ? now : null,
    processed_by_member_id: access.member.id,
  };
  return json({ transfer: transferJson(processed, false) });
}
