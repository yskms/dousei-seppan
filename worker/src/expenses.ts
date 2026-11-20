// 支出の一覧・登録・編集・削除。リクエスト・レスポンスの形は docs/backend-design.md 9章「支出API」、
// 規則は同3章（負担）・5章（メンバー）・8章（競合制御・対象月）。
//
// 書き込み（登録・編集・削除）は、すべて writeToGroupWithRetry を通す（8章）:
// - バージョンを先に読み、そのあとで検証に使うデータを読む。読み込みは `plan` の中だけで行う。
// - 書くSQLは、すべて GROUP_WRITE_GUARD の条件つき。月締めもバージョンを上げるので、確認のあとに
//   その月が締められれば、競合として検出される（やり直したあとの検証で、締め済みとして断られる）。
// - 競合が続けば409（`conflict`）。
//
// 負担額は、`category` の支出には保存しない（月の集計で計算する。3章）。それ以外は、登録・編集のときに
// 計算して `expense_allocations` に保存し、あとから計算ロジックが変わっても変えない。
import {
  authenticateRequest,
  canViewMonth,
  canWriteExpenses,
  isMonthClosed,
  latestClosedMonth,
  loadGroupAccess,
  type GroupAccess,
} from './access.ts';
import {
  parseCreateExpense,
  parseUpdateExpense,
  type SplitInput,
  type UpdateExpenseInput,
} from './expenseInput.ts';
import { GROUP_WRITE_GUARD, writeToGroupWithRetry, type GroupWriteOutcome } from './groupWrite.ts';
import {
  conflict,
  forbidden,
  invalidRequest,
  json,
  noContent,
  notFound,
  readJsonObject,
  unauthorized,
} from './http.ts';
import { isMonth, maxMonth, monthIn, registerableRange } from './months.ts';
import { splitExpense } from './settlement.ts';

// 本文の上限。1件の支出は、メンバーが何人でも数百バイトほど。
const MAX_BODY_BYTES = 16 * 1024;

type SplitMethod = 'category' | 'equal' | 'ratio' | 'fixed' | 'single';

interface ExpenseRow {
  id: string;
  group_id: string;
  expense_date: string;
  target_month: string;
  description: string | null;
  amount_minor: number;
  category_id: string;
  payer_member_id: string;
  created_by_member_id: string;
  split_method: SplitMethod;
  recurring_expense_id: string | null;
  created_at: number;
  updated_at: number;
}

const EXPENSE_COLUMNS = `id, group_id, expense_date, target_month, description, amount_minor, category_id,
  payer_member_id, created_by_member_id, split_method, recurring_expense_id, created_at, updated_at`;

/** `category` 以外の支出の、メンバーごとの確定負担額（3章）。 */
interface Allocation {
  memberId: string;
  burdenMinor: number;
  /** 割合指定（ratio）のときだけ入る。 */
  shareBasisPoints: number | null;
}

interface AllocationRow {
  expense_id: string;
  member_id: string;
  burden_minor: number;
  share_basis_points: number | null;
}

const toAllocation = (row: AllocationRow): Allocation => ({
  memberId: row.member_id,
  burdenMinor: row.burden_minor,
  shareBasisPoints: row.share_basis_points,
});

function expenseJson(row: ExpenseRow, allocations: readonly Allocation[]) {
  return {
    id: row.id,
    expenseDate: row.expense_date,
    targetMonth: row.target_month,
    description: row.description,
    amountMinor: row.amount_minor,
    categoryId: row.category_id,
    payerMemberId: row.payer_member_id,
    createdByMemberId: row.created_by_member_id,
    recurringExpenseId: row.recurring_expense_id,
    splitMethod: row.split_method,
    // category の支出は []（負担は月の集計で計算する）。
    allocations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
type ExpenseJson = ReturnType<typeof expenseJson>;

// ---------------------------------------------------------------------------
// 読み取り（検証用）

interface MemberRow {
  id: string;
  status: 'active' | 'leaving' | 'left' | 'deleted';
  history_from_month: string;
  expense_end_month: string | null;
  leave_requested_month: string | null;
}

/** グループの全メンバー（少人数。IN句のバインド数の上限を避けるため、まとめて読む）。 */
async function loadMembers(db: D1Database, groupId: string): Promise<Map<string, MemberRow>> {
  const { results } = await db
    .prepare(
      `SELECT id, status, history_from_month, expense_end_month, leave_requested_month
         FROM group_members WHERE group_id = ?`,
    )
    .bind(groupId)
    .all<MemberRow>();
  return new Map(results.map((row) => [row.id, row]));
}

/**
 * その月の支出の支払者・負担の対象にできるか（5章）。
 * 削除したユーザー・脱退済みは選べない。参加（復帰）した月より前の月も選べない。
 * 最後の月は、脱退が確定していれば脱退月（`expense_end_month`）。脱退を選んだだけで、まだ確定していない
 * （`leave_requested_month`）メンバーも、その翌月以降は選べない。翌月1日の確定はCronが書くので、確定を待つと、
 * Cronが動くまでの間、翌月の支出に入ってしまう（あとで確定しても、保存した個別の負担額は戻らない）。
 * 脱退月までは選べる（脱退月の支出を、脱退者の支払として登録できるように）。
 */
function isMemberAvailable(member: MemberRow, month: string): boolean {
  if (member.status === 'deleted' || member.status === 'left') return false;
  if (month < member.history_from_month) return false;
  const lastMonth = member.expense_end_month ?? member.leave_requested_month;
  if (lastMonth !== null && month > lastMonth) return false;
  return true;
}

interface MemberRef {
  id: string;
  /** 失敗したときに返す項目名。 */
  field: string;
  /** その月に使えることまで見るか。false なら、グループに居ることだけ見る。 */
  checkAvailable: boolean;
}

/**
 * グループに居て（居なければ400。他グループのIDなど）、見る指定のものは、その月に使えるメンバーか（使えなければ409）。
 */
function checkMembers(members: Map<string, MemberRow>, refs: readonly MemberRef[], month: string): Response | null {
  for (const ref of refs) {
    const member = members.get(ref.id);
    if (member === undefined) return invalidRequest(ref.field);
    if (ref.checkAvailable && !isMemberAvailable(member, month)) {
      return conflict('member_not_available', { memberId: ref.id });
    }
  }
  return null;
}

/** 費目。他グループのID（グループ内に無い）は null。 */
async function loadCategory(
  db: D1Database,
  groupId: string,
  categoryId: string,
): Promise<{ archived: boolean } | null> {
  const row = await db
    .prepare('SELECT archived_at FROM categories WHERE id = ? AND group_id = ?')
    .bind(categoryId, groupId)
    .first<{ archived_at: number | null }>();
  return row === null ? null : { archived: row.archived_at !== null };
}

async function loadExpense(db: D1Database, groupId: string, expenseId: string): Promise<ExpenseRow | null> {
  return db
    .prepare(`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE id = ? AND group_id = ?`)
    .bind(expenseId, groupId)
    .first<ExpenseRow>();
}

/** グループを問わずIDで探す（登録の再送の判定用。支出のIDは、全グループで一意）。 */
async function loadExpenseAnywhere(db: D1Database, expenseId: string): Promise<ExpenseRow | null> {
  return db.prepare(`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE id = ?`).bind(expenseId).first<ExpenseRow>();
}

async function loadAllocations(db: D1Database, groupId: string, expenseId: string): Promise<Allocation[]> {
  const { results } = await db
    .prepare(
      `SELECT expense_id, member_id, burden_minor, share_basis_points FROM expense_allocations
        WHERE expense_id = ? AND group_id = ? ORDER BY member_id`,
    )
    .bind(expenseId, groupId)
    .all<AllocationRow>();
  return results.map(toAllocation);
}

/** 支出の登録先にできる月の範囲。本人が見られない月（参加前）は含めない。 */
async function registerableMonths(
  db: D1Database,
  access: GroupAccess,
  now: number,
): Promise<{ from: string; to: string }> {
  const range = registerableRange({
    createdMonth: monthIn(access.group.timezone, access.group.createdAt),
    currentMonth: monthIn(access.group.timezone, now),
    latestClosedMonth: await latestClosedMonth(db, access.group.id),
  });
  return { from: maxMonth(range.from, access.member.historyFromMonth), to: range.to };
}

const monthNotRegisterable = (range: { from: string; to: string }): Response =>
  conflict('month_not_registerable', { from: range.from, to: range.to });

// ---------------------------------------------------------------------------
// 負担額（個別設定）

/** 負担の指定に出てくるメンバーと、不備のときに返す項目名（`split.shares` など。入力の形と揃える）。 */
function splitMemberRefs(split: SplitInput): { id: string; field: string }[] {
  switch (split.method) {
    case 'category':
      return [];
    case 'single':
      return [{ id: split.memberId, field: 'split.memberId' }];
    case 'equal':
      return split.memberIds.map((id) => ({ id, field: 'split.memberIds' }));
    case 'ratio':
      return split.shares.map((share) => ({ id: share.memberId, field: 'split.shares' }));
    case 'fixed':
      return split.amounts.map((item) => ({ id: item.memberId, field: 'split.amounts' }));
  }
}

/** 個別設定の負担額を計算する（`category` は []）。金額指定の合計が金額と合わなければ、項目名を返す。 */
function buildAllocations(
  amountMinor: number,
  split: SplitInput,
): { ok: true; allocations: Allocation[] } | { ok: false; field: string } {
  if (split.method === 'category') return { ok: true, allocations: [] };
  if (split.method === 'fixed') {
    // 差額の自動配分はしない（2章「金額指定」）。
    const sum = split.amounts.reduce((acc, item) => acc + item.amount, 0);
    if (sum !== amountMinor) return { ok: false, field: 'split.amounts' };
  }
  const shareOf = new Map(
    split.method === 'ratio' ? split.shares.map((share) => [share.memberId, share.basisPoints] as const) : [],
  );
  return {
    ok: true,
    allocations: splitExpense(amountMinor, split).map((item) => ({
      memberId: item.memberId,
      burdenMinor: item.amount,
      shareBasisPoints: shareOf.get(item.memberId) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// 書き込みのSQL。すべて GROUP_WRITE_GUARD の条件つき（8章）。

function insertExpenseStatement(db: D1Database, token: string, row: ExpenseRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO expenses (${EXPENSE_COLUMNS})
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (${GROUP_WRITE_GUARD})`,
    )
    .bind(
      row.id,
      row.group_id,
      row.expense_date,
      row.target_month,
      row.description,
      row.amount_minor,
      row.category_id,
      row.payer_member_id,
      row.created_by_member_id,
      row.split_method,
      row.recurring_expense_id,
      row.created_at,
      row.updated_at,
      row.group_id,
      token,
    );
}

function insertAllocationStatement(
  db: D1Database,
  token: string,
  groupId: string,
  expenseId: string,
  allocation: Allocation,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO expense_allocations (group_id, expense_id, member_id, burden_minor, share_basis_points)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (${GROUP_WRITE_GUARD})`,
    )
    .bind(groupId, expenseId, allocation.memberId, allocation.burdenMinor, allocation.shareBasisPoints, groupId, token);
}

function updateExpenseStatement(db: D1Database, token: string, row: ExpenseRow): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE expenses SET expense_date = ?, target_month = ?, description = ?, amount_minor = ?,
              category_id = ?, payer_member_id = ?, split_method = ?, updated_at = ?
        WHERE id = ? AND group_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`,
    )
    .bind(
      row.expense_date,
      row.target_month,
      row.description,
      row.amount_minor,
      row.category_id,
      row.payer_member_id,
      row.split_method,
      row.updated_at,
      row.id,
      row.group_id,
      row.group_id,
      token,
    );
}

function deleteAllocationsStatement(
  db: D1Database,
  token: string,
  groupId: string,
  expenseId: string,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM expense_allocations WHERE expense_id = ? AND group_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`)
    .bind(expenseId, groupId, groupId, token);
}

function deleteExpenseStatement(db: D1Database, token: string, groupId: string, expenseId: string): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM expenses WHERE id = ? AND group_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`)
    .bind(expenseId, groupId, groupId, token);
}

/** 書き込めなかった結果の応答（成功以外）。 */
function failureResponse(outcome: Exclude<GroupWriteOutcome<unknown, Response>, { status: 'written' }>): Response {
  switch (outcome.status) {
    case 'rejected':
      return outcome.reject;
    case 'no_group':
      return notFound();
    case 'conflict':
      // 読み直してやり直しても競合した（'version'）、または一意制約に違反した（'unique'。読み直しても同じ）。
      // アプリは、最新の状態を読み直して、入力内容を残したまま案内する。
      return conflict('conflict');
  }
}

// ---------------------------------------------------------------------------
// GET /groups/:id/expenses?month=YYYY-MM

export async function handleListExpenses(request: Request, env: Env, now: number, groupId: string): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();

  const month = new URL(request.url).searchParams.get('month');
  if (!isMonth(month)) return invalidRequest('month');

  const access = await loadGroupAccess(env.DB, session.userId, groupId);
  if (access === null) return notFound();
  if (!canViewMonth(access, month)) return forbidden();

  // 支出と負担額は、1つの batch（同じ時点）で読む。
  const [expenses, allocations, closing] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE group_id = ?1 AND target_month = ?2
          ORDER BY expense_date DESC, created_at DESC, id DESC`,
      )
      .bind(groupId, month),
    // 主キー（expense_id, member_id）で引く。グループ全体の負担額を読まない。
    env.DB
      .prepare(
        `SELECT expense_id, member_id, burden_minor, share_basis_points FROM expense_allocations
          WHERE group_id = ?1 AND expense_id IN (SELECT id FROM expenses WHERE group_id = ?1 AND target_month = ?2)
          ORDER BY expense_id, member_id`,
      )
      .bind(groupId, month),
    env.DB
      .prepare('SELECT 1 AS found FROM monthly_closings WHERE group_id = ? AND target_month = ?')
      .bind(groupId, month),
  ]);

  const byExpense = new Map<string, Allocation[]>();
  for (const row of allocations.results as AllocationRow[]) {
    const list = byExpense.get(row.expense_id) ?? [];
    list.push(toAllocation(row));
    byExpense.set(row.expense_id, list);
  }
  return json({
    month,
    closed: closing.results.length > 0,
    expenses: (expenses.results as ExpenseRow[]).map((row) => expenseJson(row, byExpense.get(row.id) ?? [])),
  });
}

// ---------------------------------------------------------------------------
// POST /groups/:id/expenses

export async function handleCreateExpense(request: Request, env: Env, now: number, groupId: string): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = parseCreateExpense(body.body);
  if (!parsed.ok) return invalidRequest(parsed.field);
  const input = parsed.value;
  const db = env.DB;

  const outcome = await writeToGroupWithRetry<ExpenseJson, Response>(db, groupId, async () => {
    const access = await loadGroupAccess(db, session.userId, groupId);
    if (access === null) return { reject: notFound() };
    if (!canWriteExpenses(access, now)) return { reject: forbidden() };

    // 同じIDの再送（通信が途切れて、アプリが同じ登録をもう一度送った）は、新しく作らず、保存済みの支出を200で返す。
    // 内容は見比べず、保存済みのものをそのまま返す（最初の登録のあとに編集されていれば、編集後の状態）。
    // 判定は、バージョンを読んだあとのこの中で行う。最初の登録と再送が同時に走っても、負けたほうは競合になり、
    // やり直した判定で、勝ったほうの支出を見つける。
    // 登録した人と別のメンバー・別のグループが使っているIDは、中身も、どのグループのものかも返さず、競合と同じ409にする。
    // IDが使われているかどうかは、応答（409か、登録できるか）の違いで分かる。登録の `id` をUUIDに限っているので、
    // 当てずっぽうで探すことはできない。
    // 判定は、登録できる月・メンバーの検査より前に行う（再送の間に月が締められても、同じ結果を返すため）。
    // 消した支出のIDの再送は、新しい登録として扱う（消したことは、IDからは分からない）。
    // 200の返却にも `reject` を使う（意味は「書かずに、この応答をそのまま返す」。バージョンも上げない）。
    if (input.id !== null) {
      const existing = await loadExpenseAnywhere(db, input.id);
      if (existing !== null) {
        if (existing.group_id !== groupId || existing.created_by_member_id !== access.member.id) {
          return { reject: conflict('conflict') };
        }
        const allocations = await loadAllocations(db, groupId, existing.id);
        return { reject: json({ expense: expenseJson(existing, allocations) }) };
      }
    }

    const [range, category, members] = await Promise.all([
      registerableMonths(db, access, now),
      loadCategory(db, groupId, input.categoryId),
      loadMembers(db, groupId),
    ]);
    if (input.targetMonth < range.from || input.targetMonth > range.to) {
      return { reject: monthNotRegisterable(range) };
    }
    if (category === null) return { reject: invalidRequest('categoryId') };
    if (category.archived) return { reject: conflict('category_not_available') };
    const memberProblem = checkMembers(
      members,
      [
        { id: input.payerMemberId, field: 'payerMemberId', checkAvailable: true },
        ...splitMemberRefs(input.split).map((ref) => ({ ...ref, checkAvailable: true })),
      ],
      input.targetMonth,
    );
    if (memberProblem !== null) return { reject: memberProblem };
    const built = buildAllocations(input.amountMinor, input.split);
    if (!built.ok) return { reject: invalidRequest(built.field) };

    const row: ExpenseRow = {
      id: input.id ?? crypto.randomUUID(),
      group_id: groupId,
      expense_date: input.expenseDate,
      target_month: input.targetMonth,
      description: input.description,
      amount_minor: input.amountMinor,
      category_id: input.categoryId,
      payer_member_id: input.payerMemberId,
      created_by_member_id: access.member.id,
      split_method: input.split.method,
      recurring_expense_id: null,
      created_at: now,
      updated_at: now,
    };
    return {
      value: expenseJson(row, built.allocations),
      write: (token) => [
        insertExpenseStatement(db, token, row),
        ...built.allocations.map((allocation) => insertAllocationStatement(db, token, groupId, row.id, allocation)),
      ],
    };
  });

  return outcome.status === 'written' ? json({ expense: outcome.value }, 201) : failureResponse(outcome);
}

// ---------------------------------------------------------------------------
// PATCH /expenses/:id、DELETE /expenses/:id

/** 支出の属するグループ。無ければ null。権限の確認は、このあと groupId で行う（IDだけでは何も見せない）。 */
async function findExpenseGroup(db: D1Database, expenseId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT group_id FROM expenses WHERE id = ?')
    .bind(expenseId)
    .first<{ group_id: string }>();
  return row === null ? null : row.group_id;
}

export async function handleUpdateExpense(
  request: Request,
  env: Env,
  now: number,
  expenseId: string,
): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = parseUpdateExpense(body.body);
  // 空の本文は項目を特定できない（field は空文字）。応答には field を付けない。
  if (!parsed.ok) return invalidRequest(parsed.field === '' ? undefined : parsed.field);
  const patch: UpdateExpenseInput = parsed.value;
  const db = env.DB;

  const groupId = await findExpenseGroup(db, expenseId);
  if (groupId === null) return notFound();

  const outcome = await writeToGroupWithRetry<ExpenseJson, Response>(db, groupId, async () => {
    const access = await loadGroupAccess(db, session.userId, groupId);
    if (access === null) return { reject: notFound() };
    const current = await loadExpense(db, groupId, expenseId);
    if (current === null || !canViewMonth(access, current.target_month)) return { reject: notFound() };
    if (!canWriteExpenses(access, now)) return { reject: forbidden() };
    if (await isMonthClosed(db, groupId, current.target_month)) return { reject: conflict('month_closed') };

    const next: ExpenseRow = {
      ...current,
      expense_date: patch.expenseDate ?? current.expense_date,
      target_month: patch.targetMonth ?? current.target_month,
      description: patch.description !== undefined ? patch.description : current.description,
      amount_minor: patch.amountMinor ?? current.amount_minor,
      category_id: patch.categoryId ?? current.category_id,
      payer_member_id: patch.payerMemberId ?? current.payer_member_id,
      split_method: patch.split?.method ?? current.split_method,
      updated_at: now,
    };
    const monthChanged = next.target_month !== current.target_month;
    const amountChanged = next.amount_minor !== current.amount_minor;
    // 個別設定の負担額は金額に結びついている。金額が変わるなら、負担の指定もやり直してもらう
    // （金額指定は自動で配分しない。割合・均等も、画面で確認した負担を勝手に変えない）。
    if (patch.split === undefined && amountChanged && current.split_method !== 'category') {
      return { reject: invalidRequest('split') };
    }

    const [range, category, members, stored] = await Promise.all([
      monthChanged ? registerableMonths(db, access, now) : null,
      next.category_id !== current.category_id ? loadCategory(db, groupId, next.category_id) : null,
      loadMembers(db, groupId),
      loadAllocations(db, groupId, expenseId),
    ]);
    if (range !== null && (next.target_month < range.from || next.target_month > range.to)) {
      return { reject: monthNotRegisterable(range) };
    }
    if (next.category_id !== current.category_id) {
      if (category === null) return { reject: invalidRequest('categoryId') };
      if (category.archived) return { reject: conflict('category_not_available') };
    }

    // 負担額（個別設定）。`split` を送ったときだけ置き換える。
    let allocations = stored;
    let replaceAllocations = false;
    if (patch.split !== undefined) {
      const built = buildAllocations(next.amount_minor, patch.split);
      if (!built.ok) return { reject: invalidRequest(built.field) };
      allocations = built.allocations;
      replaceAllocations = !(patch.split.method === 'category' && current.split_method === 'category');
    }

    // 支払者・負担の対象の検証。脱退・削除したメンバーが入った既存の支出でも、内容や日付は直せるように、
    // その月に使えるかは「新しく選んだ・負担が増える」メンバーだけ見る（負担を増やせる＝選べる、と同じ扱い。
    // 本人が異議を出せない相手に、負担を寄せ直せないようにする）。登録する月を変えるときは、全員分見直す。
    // グループに居るかは、どのメンバーも必ず見る（他のグループのIDで外部キーに落ちないように）。
    const storedBurden = new Map(stored.map((allocation) => [allocation.memberId, allocation.burdenMinor]));
    const refs: MemberRef[] = [
      {
        id: next.payer_member_id,
        field: 'payerMemberId',
        checkAvailable: monthChanged || next.payer_member_id !== current.payer_member_id,
      },
    ];
    if (patch.split !== undefined) {
      const newBurden = new Map(allocations.map((allocation) => [allocation.memberId, allocation.burdenMinor]));
      for (const ref of splitMemberRefs(patch.split)) {
        const before = storedBurden.get(ref.id);
        refs.push({
          ...ref,
          checkAvailable: monthChanged || before === undefined || (newBurden.get(ref.id) ?? 0) > before,
        });
      }
    } else if (monthChanged) {
      for (const memberId of storedBurden.keys()) refs.push({ id: memberId, field: 'split', checkAvailable: true });
    }
    const memberProblem = checkMembers(members, refs, next.target_month);
    if (memberProblem !== null) return { reject: memberProblem };

    return {
      value: expenseJson(next, allocations),
      write: (token) => [
        ...(replaceAllocations ? [deleteAllocationsStatement(db, token, groupId, expenseId)] : []),
        updateExpenseStatement(db, token, next),
        ...(replaceAllocations
          ? allocations.map((allocation) => insertAllocationStatement(db, token, groupId, expenseId, allocation))
          : []),
      ],
    };
  });

  return outcome.status === 'written' ? json({ expense: outcome.value }) : failureResponse(outcome);
}

export async function handleDeleteExpense(
  request: Request,
  env: Env,
  now: number,
  expenseId: string,
): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();
  const db = env.DB;

  const groupId = await findExpenseGroup(db, expenseId);
  if (groupId === null) return notFound();

  const outcome = await writeToGroupWithRetry<null, Response>(db, groupId, async () => {
    const access = await loadGroupAccess(db, session.userId, groupId);
    if (access === null) return { reject: notFound() };
    const current = await loadExpense(db, groupId, expenseId);
    if (current === null || !canViewMonth(access, current.target_month)) return { reject: notFound() };
    if (!canWriteExpenses(access, now)) return { reject: forbidden() };
    if (await isMonthClosed(db, groupId, current.target_month)) return { reject: conflict('month_closed') };

    return {
      value: null,
      // 負担額（子）から先に消す。
      write: (token) => [
        deleteAllocationsStatement(db, token, groupId, expenseId),
        deleteExpenseStatement(db, token, groupId, expenseId),
      ],
    };
  });

  return outcome.status === 'written' ? noContent() : failureResponse(outcome);
}
