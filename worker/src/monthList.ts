// ホームの月ピッカー用の、月の一覧（GET /groups/:id/months）。形と規則は docs/backend-design.md 9章「月締め・精算API」
// の「月の一覧」、画面は screens.md 3章「月の切り替え」。
//
// - 並ぶ月は、本人が見られる最も古い月（参加・復帰した月）から、支出を登録できる最も新しい月（`registerableRange` の
//   上端。今月を早めに締めていれば翌月）まで。範囲の決め方は、支出の登録・割合の編集と同じ関数を使う（アプリが
//   「選べる月」を書き写さない）。
// - 状態は、締めと送金から導く（別に保存しない。4章）。月の集計（summary）は1か月ずつなので、ここでは集計をしない。
import { authenticateRequest, loadGroupAccess } from './access.ts';
import { json, notFound, unauthorized } from './http.ts';
import { monthIn, nextMonth, registerableRange } from './months.ts';

/**
 * 月の状態。
 * - `open`: 未締め。締められるかは、その月の summary の `close` を見る。
 * - `skipped`: 締めずに飛ばした月（最後に締めた月より前で、締めていない。4章）。もう締められない。
 * - `unsettled`: 締めたが、未処理（pending）の送金が残っている。
 * - `settled`: 締めて、すべての送金が処理済み（settled か carried。送金が0件の月も）。
 */
export type MonthListStatus = 'open' | 'skipped' | 'unsettled' | 'settled';

export interface MonthListEntry {
  month: string;
  status: MonthListStatus;
}

/**
 * 月の一覧を組み立てる（DBを読まない）。`closedMonths` は、締めた月とその送金に未処理があるか
 * （`fromMonth` より前の月は、渡さなくてよい）。`fromMonth` が `toMonth` より後なら空。
 */
export function buildMonthList(input: {
  fromMonth: string;
  toMonth: string;
  closedMonths: ReadonlyMap<string, { hasPending: boolean }>;
  latestClosedMonth: string | null;
}): MonthListEntry[] {
  const months: MonthListEntry[] = [];
  for (let month = input.fromMonth; month <= input.toMonth; month = nextMonth(month)) {
    months.push({ month, status: statusOf(month, input) });
  }
  return months;
}

function statusOf(
  month: string,
  input: { closedMonths: ReadonlyMap<string, { hasPending: boolean }>; latestClosedMonth: string | null },
): MonthListStatus {
  const closed = input.closedMonths.get(month);
  if (closed !== undefined) return closed.hasPending ? 'unsettled' : 'settled';
  return input.latestClosedMonth !== null && month < input.latestClosedMonth ? 'skipped' : 'open';
}

export async function handleListMonths(request: Request, env: Env, now: number, groupId: string): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();
  const db = env.DB;

  const access = await loadGroupAccess(db, session.userId, groupId);
  if (access === null) return notFound();

  // 締めた月と、その月に未処理の送金があるか。送金は、締めごとに `idx_settlement_transfers_group`（group_id, closing_id）で
  // 引く（`EXISTS` は、未処理が見つかった時点で止まる）。締めた月の数と、その送金の数だけ読む。
  const [closings, latest] = await db.batch([
    db
      .prepare(
        `SELECT c.target_month AS month,
                EXISTS (SELECT 1 FROM settlement_transfers t
                         WHERE t.group_id = c.group_id AND t.closing_id = c.id AND t.status = 'pending') AS has_pending
           FROM monthly_closings c
          WHERE c.group_id = ?1 AND c.target_month >= ?2`,
      )
      .bind(groupId, access.member.historyFromMonth),
    db.prepare('SELECT max(target_month) AS month FROM monthly_closings WHERE group_id = ?').bind(groupId),
  ]);

  const closedMonths = new Map<string, { hasPending: boolean }>();
  for (const row of closings.results as { month: string; has_pending: number }[]) {
    closedMonths.set(row.month, { hasPending: row.has_pending === 1 });
  }
  const latestClosedMonth = (latest.results[0] as { month: string | null } | undefined)?.month ?? null;

  const currentMonth = monthIn(access.group.timezone, now);
  const range = registerableRange({
    createdMonth: monthIn(access.group.timezone, access.group.createdAt),
    currentMonth,
    latestClosedMonth,
  });
  return json({
    // 初期表示の月（グループのタイムゾーンでの、カレンダー上の今月）。今月を締めていても、翌月ではなく今月。
    currentMonth,
    months: buildMonthList({
      fromMonth: access.member.historyFromMonth,
      toMonth: range.to,
      closedMonths,
      latestClosedMonth,
    }),
  });
}
