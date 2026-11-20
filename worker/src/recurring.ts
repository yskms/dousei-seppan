// 固定費(テンプレート)の一覧・登録・変更(止める・再開する・終了月を含む)。形と規則は
// docs/backend-design.md 9章「固定費API」、毎月の自動登録は同7章(src/recurringRun.ts)。
//
// 書き込み(登録・変更)は、すべて writeToGroupWithRetry を通す(8章): バージョンを先に読み、そのあとで検証に使う
// データを読む。読み込みは `plan` の中だけで行う。書くSQLは、すべて GROUP_WRITE_GUARD の条件つき。
//
// テンプレートは、一度でも支出を作ったら物理削除しない(作った支出と生成記録が参照する。付録A-4)。代わりに、止める
// (`manual`)・終了月を決める。一度も作っていないものだけ、削除できる(`DELETE`)。アーカイブした費目の固定費は、止めずに、
// 自動登録だけを見送る(`categoryArchived` で知らせる。7章)。
import { authenticateRequest, canEditGroupSettings, latestClosedMonth, loadGroupAccess, type GroupAccess } from './access.ts';
import {
  buildAllocations,
  checkMembers,
  currencyMismatch,
  failureResponse,
  loadMembers,
  splitMemberRefs,
  type MemberRef,
} from './expenses.ts';
import type { SplitInput } from './expenseInput.ts';
import { GROUP_WRITE_GUARD, insertRowsGuarded, writeToGroupWithRetry } from './groupWrite.ts';
import { conflict, forbidden, invalidRequest, json, noContent, notFound, readJsonObject, unauthorized } from './http.ts';
import { MAX_RECURRING_EXPENSES_PER_GROUP } from './limits.ts';
import { dateIn, maxMonth, monthIn, recurringTargetMonth, scheduledDate } from './months.ts';
import { parseCreateRecurring, parseUpdateRecurring, type UpdateRecurringInput } from './recurringInput.ts';

// 本文の上限。1件の固定費は、メンバーが何人でも数百バイトほど。
const MAX_BODY_BYTES = 16 * 1024;

export type SplitMethod = 'category' | 'equal' | 'ratio' | 'fixed' | 'single';
export type PausedReason = 'member_changed' | 'payer_left' | 'manual';

export interface RecurringRow {
  id: string;
  group_id: string;
  description: string | null;
  amount_minor: number;
  category_id: string;
  payer_member_id: string;
  split_method: SplitMethod;
  day_of_month: number;
  start_month: string;
  end_month: string | null;
  paused_at: number | null;
  paused_reason: PausedReason | null;
  created_at: number;
  updated_at: number;
  /** 費目をアーカイブした日時(結合して読む)。アーカイブしていなければ null。 */
  category_archived_at: number | null;
}

export interface RecurringAllocationRow {
  recurring_expense_id: string;
  member_id: string;
  share_basis_points: number | null;
  amount_minor: number | null;
}

/** 固定費と費目(アーカイブの有無)を結合して読む列と表。`r`・`c` の別名は、これを使う文が揃える。 */
export const RECURRING_COLUMNS = `r.id AS id, r.group_id AS group_id, r.description AS description, r.amount_minor AS amount_minor,
  r.category_id AS category_id, r.payer_member_id AS payer_member_id, r.split_method AS split_method,
  r.day_of_month AS day_of_month, r.start_month AS start_month, r.end_month AS end_month,
  r.paused_at AS paused_at, r.paused_reason AS paused_reason, r.created_at AS created_at, r.updated_at AS updated_at,
  c.archived_at AS category_archived_at`;
export const RECURRING_FROM = 'recurring_expenses r JOIN categories c ON c.id = r.category_id AND c.group_id = r.group_id';

/** 保存してある個別の負担設定から、負担の指定に戻す。形が合わない(あってはならない)ときは投げる。 */
export function splitFromRows(method: SplitMethod, rows: readonly RecurringAllocationRow[]): SplitInput {
  switch (method) {
    case 'category':
      return { method: 'category' };
    case 'single': {
      const [only] = rows;
      if (rows.length !== 1 || only === undefined) throw new Error('single の固定費の負担設定が1行でない');
      return { method: 'single', memberId: only.member_id };
    }
    case 'equal':
      return { method: 'equal', memberIds: rows.map((row) => row.member_id) };
    case 'ratio':
      return {
        method: 'ratio',
        shares: rows.map((row) => {
          if (row.share_basis_points === null) throw new Error('ratio の固定費の負担設定に割合が無い');
          return { memberId: row.member_id, basisPoints: row.share_basis_points };
        }),
      };
    case 'fixed':
      return {
        method: 'fixed',
        amounts: rows.map((row) => {
          if (row.amount_minor === null) throw new Error('fixed の固定費の負担設定に金額が無い');
          return { memberId: row.member_id, amount: row.amount_minor };
        }),
      };
  }
}

/** 負担の指定を保存する行(`recurring_expense_allocations`)。`category` は行を持たない。 */
export function allocationRowsOf(
  groupId: string,
  recurringId: string,
  split: SplitInput,
): (string | number | null)[][] {
  switch (split.method) {
    case 'category':
      return [];
    case 'single':
      return [[groupId, recurringId, split.memberId, null, null]];
    case 'equal':
      return split.memberIds.map((memberId) => [groupId, recurringId, memberId, null, null]);
    case 'ratio':
      return split.shares.map((share) => [groupId, recurringId, share.memberId, share.basisPoints, null]);
    case 'fixed':
      return split.amounts.map((item) => [groupId, recurringId, item.memberId, null, item.amount]);
  }
}

const ALLOCATION_COLUMNS = ['group_id', 'recurring_expense_id', 'member_id', 'share_basis_points', 'amount_minor'];

/** アプリへ返す、負担の指定(入力と同じ形。金額指定の金額は `amountMinor`)。 */
function splitJson(split: SplitInput) {
  return split.method === 'fixed'
    ? { method: 'fixed' as const, amounts: split.amounts.map((item) => ({ memberId: item.memberId, amountMinor: item.amount })) }
    : split;
}

function recurringJson(row: RecurringRow, split: SplitInput) {
  return {
    id: row.id,
    description: row.description,
    amountMinor: row.amount_minor,
    categoryId: row.category_id,
    // 費目をアーカイブしていると、自動登録は見送られる(止めてはいない)。費目を戻すか、費目を選び直す。
    categoryArchived: row.category_archived_at !== null,
    payerMemberId: row.payer_member_id,
    split: splitJson(split),
    dayOfMonth: row.day_of_month,
    startMonth: row.start_month,
    endMonth: row.end_month,
    pausedAt: row.paused_at,
    pausedReason: row.paused_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
type RecurringJson = ReturnType<typeof recurringJson>;

/** 書き込みの応答。`thisMonthSkipped` は、今月の分を作らない記録を、この書き込みで残したか(アプリが案内する)。 */
interface WrittenRecurring {
  recurringExpense: RecurringJson;
  thisMonthSkipped: boolean;
}

async function loadRecurringOne(
  db: D1Database,
  groupId: string,
  recurringId: string,
): Promise<{ row: RecurringRow; split: SplitInput } | null> {
  const [row, allocations] = await Promise.all([
    db
      .prepare(`SELECT ${RECURRING_COLUMNS} FROM ${RECURRING_FROM} WHERE r.id = ? AND r.group_id = ?`)
      .bind(recurringId, groupId)
      .first<RecurringRow>(),
    db
      .prepare(
        `SELECT recurring_expense_id, member_id, share_basis_points, amount_minor FROM recurring_expense_allocations
          WHERE recurring_expense_id = ? AND group_id = ? ORDER BY member_id`,
      )
      .bind(recurringId, groupId)
      .all<RecurringAllocationRow>(),
  ]);
  if (row === null) return null;
  return { row, split: splitFromRows(row.split_method, allocations.results) };
}

/** 費目。他グループのID(グループ内に無い)は null。 */
async function loadCategoryArchived(
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

const categoryNotAvailable = (): Response => conflict('category_not_available');

/**
 * 支払者・負担の対象が使えるかを見る月 = 最初に支出を作る月。自動登録(recurringRun.ts)が見る月と同じ決め方にする
 * (今月を早めに締めていれば、翌月。APIは通すのに、Cronが黙って見送る、を避ける)。
 */
async function firstTargetMonth(db: D1Database, access: GroupAccess, startMonth: string, now: number): Promise<string> {
  const scheduled = maxMonth(startMonth, monthIn(access.group.timezone, now));
  return recurringTargetMonth(scheduled, await latestClosedMonth(db, access.group.id));
}

/** 今月の分を、いま作る時期に来ている状態か(止まっていない、開始月〜終了月に今月が入る、予定日を過ぎた)。生成記録は見ない。 */
function isDueThisMonth(
  state: { paused_at: number | null; day_of_month: number; start_month: string; end_month: string | null },
  month: string,
  today: string,
): boolean {
  return (
    state.paused_at === null &&
    state.start_month <= month &&
    (state.end_month === null || month <= state.end_month) &&
    scheduledDate(month, state.day_of_month) <= today
  );
}

const RUN_COLUMNS = ['group_id', 'recurring_expense_id', 'scheduled_month', 'expense_id', 'created_at'];

/**
 * 今月の分を「作らなかった」記録(生成記録。支出のIDは無し)。登録・再開などで、**新しく**今月の予定日を過ぎた状態に
 * したとき、すぐに今月の分が作られて、手で入力した分と二重にならないように残す(企画メモ7章「設定変更は原則として
 * 翌月以降に反映」。7章)。
 */
function skipThisMonthStatements(
  db: D1Database,
  token: string,
  groupId: string,
  recurringId: string,
  month: string,
  now: number,
): D1PreparedStatement[] {
  return insertRowsGuarded(db, token, groupId, 'recurring_expense_runs', RUN_COLUMNS, [[groupId, recurringId, month, null, now]]);
}

// ---------------------------------------------------------------------------
// 書き込みのSQL。すべて GROUP_WRITE_GUARD の条件つき(8章)。

const INSERT_COLUMNS = `id, group_id, description, amount_minor, category_id, payer_member_id, split_method, day_of_month,
  start_month, end_month, paused_at, paused_reason, created_at, updated_at`;

function insertRecurringStatement(db: D1Database, token: string, row: RecurringRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO recurring_expenses (${INSERT_COLUMNS})
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (${GROUP_WRITE_GUARD})`,
    )
    .bind(
      row.id,
      row.group_id,
      row.description,
      row.amount_minor,
      row.category_id,
      row.payer_member_id,
      row.split_method,
      row.day_of_month,
      row.start_month,
      row.end_month,
      row.paused_at,
      row.paused_reason,
      row.created_at,
      row.updated_at,
      row.group_id,
      token,
    );
}

function updateRecurringStatement(db: D1Database, token: string, row: RecurringRow): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE recurring_expenses SET description = ?, amount_minor = ?, category_id = ?, payer_member_id = ?,
              split_method = ?, day_of_month = ?, start_month = ?, end_month = ?, paused_at = ?, paused_reason = ?,
              updated_at = ?
        WHERE id = ? AND group_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`,
    )
    .bind(
      row.description,
      row.amount_minor,
      row.category_id,
      row.payer_member_id,
      row.split_method,
      row.day_of_month,
      row.start_month,
      row.end_month,
      row.paused_at,
      row.paused_reason,
      row.updated_at,
      row.id,
      row.group_id,
      row.group_id,
      token,
    );
}

function deleteAllocationsStatement(db: D1Database, token: string, groupId: string, recurringId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM recurring_expense_allocations
        WHERE recurring_expense_id = ? AND group_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`,
    )
    .bind(recurringId, groupId, groupId, token);
}

// ---------------------------------------------------------------------------
// GET /groups/:id/recurring-expenses

export async function handleListRecurring(request: Request, env: Env, now: number, groupId: string): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();
  const access = await loadGroupAccess(env.DB, session.userId, groupId);
  if (access === null) return notFound();

  // 固定費と負担設定は、1つの batch(同じ時点)で読む。
  const [recurring, allocations] = await env.DB.batch([
    env.DB
      .prepare(`SELECT ${RECURRING_COLUMNS} FROM ${RECURRING_FROM} WHERE r.group_id = ? ORDER BY r.created_at, r.id`)
      .bind(groupId),
    env.DB
      .prepare(
        `SELECT recurring_expense_id, member_id, share_basis_points, amount_minor FROM recurring_expense_allocations
          WHERE group_id = ? ORDER BY recurring_expense_id, member_id`,
      )
      .bind(groupId),
  ]);
  const byRecurring = new Map<string, RecurringAllocationRow[]>();
  for (const row of allocations.results as RecurringAllocationRow[]) {
    const list = byRecurring.get(row.recurring_expense_id) ?? [];
    list.push(row);
    byRecurring.set(row.recurring_expense_id, list);
  }
  return json({
    recurringExpenses: (recurring.results as RecurringRow[]).map((row) =>
      recurringJson(row, splitFromRows(row.split_method, byRecurring.get(row.id) ?? [])),
    ),
  });
}

// ---------------------------------------------------------------------------
// POST /groups/:id/recurring-expenses

export async function handleCreateRecurring(
  request: Request,
  env: Env,
  now: number,
  groupId: string,
): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = parseCreateRecurring(body.body);
  if (!parsed.ok) return invalidRequest(parsed.field);
  const input = parsed.value;
  const db = env.DB;

  const outcome = await writeToGroupWithRetry<WrittenRecurring, Response>(db, groupId, async () => {
    const access = await loadGroupAccess(db, session.userId, groupId);
    if (access === null) return { reject: notFound() };
    if (!canEditGroupSettings(access, now)) return { reject: forbidden() };

    // 同じIDの再送は、新しく作らず、保存済みの固定費を200で返す(内容は見比べない)。支出の登録と同じ(9章)。
    // 他のグループが使っているIDは、中身も、どのグループのものかも返さず、競合と同じ409にする。
    // 200の返却にも `reject` を使う(意味は「書かずに、この応答をそのまま返す」。バージョンも上げない)。
    if (input.id !== null) {
      const owner = await db
        .prepare('SELECT group_id FROM recurring_expenses WHERE id = ?')
        .bind(input.id)
        .first<{ group_id: string }>();
      if (owner !== null) {
        if (owner.group_id !== groupId) return { reject: conflict('conflict') };
        const stored = await loadRecurringOne(db, groupId, input.id);
        if (stored !== null) return { reject: json({ recurringExpense: recurringJson(stored.row, stored.split) }) };
      }
    }

    // 再送の判定のあとに見る(再送の間に通貨が変わっても、保存済みの固定費を返す)。
    if (input.currencyCode !== null && input.currencyCode !== access.group.currencyCode) {
      return { reject: currencyMismatch(access.group.currencyCode) };
    }

    const [count, category, members] = await Promise.all([
      db
        .prepare('SELECT count(*) AS n FROM recurring_expenses WHERE group_id = ?')
        .bind(groupId)
        .first<{ n: number }>(),
      loadCategoryArchived(db, groupId, input.categoryId),
      loadMembers(db, groupId),
    ]);
    if ((count?.n ?? 0) >= MAX_RECURRING_EXPENSES_PER_GROUP) return { reject: conflict('too_many_recurring_expenses') };
    if (category === null) return { reject: invalidRequest('categoryId') };
    if (category.archived) return { reject: categoryNotAvailable() };

    // 支払者・負担の対象は、最初に支出を作る月(自動登録と同じ決め方)に使えること。
    const checkMonth = await firstTargetMonth(db, access, input.startMonth, now);
    const memberProblem = checkMembers(
      members,
      [
        { id: input.payerMemberId, field: 'payerMemberId', checkAvailable: true },
        ...splitMemberRefs(input.split).map((ref) => ({ ...ref, checkAvailable: true })),
      ],
      checkMonth,
    );
    if (memberProblem !== null) return { reject: memberProblem };
    // 金額指定の合計が金額と合うか(割合・均等・単独は、金額に依らない)。
    const built = buildAllocations(input.amountMinor, input.split);
    if (!built.ok) return { reject: invalidRequest(built.field) };

    const row: RecurringRow = {
      id: input.id ?? crypto.randomUUID(),
      group_id: groupId,
      description: input.description,
      amount_minor: input.amountMinor,
      category_id: input.categoryId,
      payer_member_id: input.payerMemberId,
      split_method: input.split.method,
      day_of_month: input.dayOfMonth,
      start_month: input.startMonth,
      end_month: input.endMonth,
      paused_at: null,
      paused_reason: null,
      created_at: now,
      updated_at: now,
      category_archived_at: null,
    };
    // 予定日をすぎた状態で作ったときは、今月の分は作らない(来月から)。
    const thisMonth = monthIn(access.group.timezone, now);
    const skipThisMonth = isDueThisMonth(row, thisMonth, dateIn(access.group.timezone, now));
    return {
      value: { recurringExpense: recurringJson(row, input.split), thisMonthSkipped: skipThisMonth },
      write: (token) => [
        insertRecurringStatement(db, token, row),
        ...insertRowsGuarded(db, token, groupId, 'recurring_expense_allocations', ALLOCATION_COLUMNS, allocationRowsOf(groupId, row.id, input.split)),
        ...(skipThisMonth ? skipThisMonthStatements(db, token, groupId, row.id, thisMonth, now) : []),
      ],
    };
  });

  return outcome.status === 'written' ? json(outcome.value, 201) : failureResponse(outcome);
}

// ---------------------------------------------------------------------------
// PATCH /recurring-expenses/:id

/** 固定費の属するグループ。無ければ null。権限の確認は、このあと groupId で行う(IDだけでは何も見せない)。 */
async function findRecurringGroup(db: D1Database, recurringId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT group_id FROM recurring_expenses WHERE id = ?')
    .bind(recurringId)
    .first<{ group_id: string }>();
  return row === null ? null : row.group_id;
}

export async function handleUpdateRecurring(
  request: Request,
  env: Env,
  now: number,
  recurringId: string,
): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = parseUpdateRecurring(body.body);
  // 空の本文は項目を特定できない(field は空文字)。応答には field を付けない。
  if (!parsed.ok) return invalidRequest(parsed.field === '' ? undefined : parsed.field);
  const patch: UpdateRecurringInput = parsed.value;
  const db = env.DB;

  const groupId = await findRecurringGroup(db, recurringId);
  if (groupId === null) return notFound();

  const outcome = await writeToGroupWithRetry<WrittenRecurring, Response>(db, groupId, async () => {
    const access = await loadGroupAccess(db, session.userId, groupId);
    if (access === null) return { reject: notFound() };
    const stored = await loadRecurringOne(db, groupId, recurringId);
    if (stored === null) return { reject: notFound() };
    if (!canEditGroupSettings(access, now)) return { reject: forbidden() };
    if (patch.currencyCode !== undefined && patch.currencyCode !== access.group.currencyCode) {
      return { reject: currencyMismatch(access.group.currencyCode) };
    }
    const current = stored.row;

    // 止める・再開する。止まっているものを止めても、理由は上書きしない。
    const resuming = patch.paused === false && current.paused_at !== null;
    let pausedAt = current.paused_at;
    let pausedReason = current.paused_reason;
    if (patch.paused === true && pausedAt === null) {
      pausedAt = now;
      pausedReason = 'manual';
    } else if (patch.paused === false) {
      pausedAt = null;
      pausedReason = null;
    }
    // `category` 以外の負担の固定費は、負担の指定を見直して(送り直して)から再開する(企画メモ7章)。止まっていた間に
    // メンバーが変わっても、理由は1つしか持てない(手動で止めたものは `member_changed` にならない)ので、理由によらず求める。
    if (resuming && current.split_method !== 'category' && patch.split === undefined) {
      return { reject: invalidRequest('split') };
    }

    const next: RecurringRow = {
      ...current,
      description: patch.description !== undefined ? patch.description : current.description,
      amount_minor: patch.amountMinor ?? current.amount_minor,
      category_id: patch.categoryId ?? current.category_id,
      payer_member_id: patch.payerMemberId ?? current.payer_member_id,
      split_method: patch.split?.method ?? current.split_method,
      day_of_month: patch.dayOfMonth ?? current.day_of_month,
      start_month: patch.startMonth ?? current.start_month,
      end_month: patch.endMonth !== undefined ? patch.endMonth : current.end_month,
      paused_at: pausedAt,
      paused_reason: pausedReason,
      updated_at: now,
    };
    // 終了月と開始月の前後(片方しか送られないときは、保存してある相手と比べる)。
    if (next.end_month !== null && next.end_month < next.start_month) {
      return { reject: invalidRequest(patch.endMonth !== undefined ? 'endMonth' : 'startMonth') };
    }
    // 金額指定の金額は、固定費の金額に結びついている。金額が変わるなら、負担の指定もやり直してもらう
    // (金額指定は自動で配分しない。割合・均等・単独は、金額に依らないので、そのまま)。
    if (patch.split === undefined && next.amount_minor !== current.amount_minor && current.split_method === 'fixed') {
      return { reject: invalidRequest('split') };
    }

    const categoryChanged = next.category_id !== current.category_id;
    const [category, members] = await Promise.all([
      categoryChanged ? loadCategoryArchived(db, groupId, next.category_id) : null,
      loadMembers(db, groupId),
    ]);
    if (categoryChanged) {
      if (category === null) return { reject: invalidRequest('categoryId') };
      if (category.archived) return { reject: categoryNotAvailable() };
      next.category_archived_at = null;
    }
    // アーカイブした費目のまま再開しても、自動登録は見送られる。再開の意図が果たされないので、断る。
    if (resuming && next.category_archived_at !== null) return { reject: categoryNotAvailable() };

    // 負担の指定を送ったときは、金額指定の合計が金額と合うか、メンバーが今使えるかを見る。
    if (patch.split !== undefined) {
      const built = buildAllocations(next.amount_minor, patch.split);
      if (!built.ok) return { reject: invalidRequest(built.field) };
    }
    // 支払者・負担の対象の検証。グループに居るかは必ず見る(他のグループのIDで外部キーに落ちないように)。
    // その月に使えるかは、新しく選んだメンバー・送り直した負担の指定と、再開するときの全員について見る
    // (止まっていた間にメンバーが変わっている。再開してすぐ、自動登録が断られ続けないように)。
    const split = patch.split ?? stored.split;
    const refs: MemberRef[] = [
      {
        id: next.payer_member_id,
        field: 'payerMemberId',
        checkAvailable: resuming || next.payer_member_id !== current.payer_member_id,
      },
      ...splitMemberRefs(split).map((ref) => ({ ...ref, checkAvailable: resuming || patch.split !== undefined })),
    ];
    const memberProblem = checkMembers(members, refs, await firstTargetMonth(db, access, next.start_month, now));
    if (memberProblem !== null) return { reject: memberProblem };

    // 今月の分を、この変更で**新しく**作る時期にしたとき(再開・日を過ぎた日に変更・開始月を今月にした)は、作らない記録を
    // 残す。もともと作る時期に来ていた(まだCronが作っていないだけ)なら、記録しない(作る分を取り上げない)。
    const thisMonth = monthIn(access.group.timezone, now);
    const today = dateIn(access.group.timezone, now);
    let skipThisMonth = false;
    if (isDueThisMonth(next, thisMonth, today) && !isDueThisMonth(current, thisMonth, today)) {
      const ran = await db
        .prepare('SELECT 1 AS found FROM recurring_expense_runs WHERE recurring_expense_id = ? AND scheduled_month = ?')
        .bind(recurringId, thisMonth)
        .first<{ found: number }>();
      skipThisMonth = ran === null;
    }

    const replaceAllocations = patch.split !== undefined && !(patch.split.method === 'category' && current.split_method === 'category');
    return {
      value: { recurringExpense: recurringJson(next, split), thisMonthSkipped: skipThisMonth },
      write: (token) => [
        ...(replaceAllocations ? [deleteAllocationsStatement(db, token, groupId, recurringId)] : []),
        updateRecurringStatement(db, token, next),
        ...(replaceAllocations && patch.split !== undefined
          ? insertRowsGuarded(db, token, groupId, 'recurring_expense_allocations', ALLOCATION_COLUMNS, allocationRowsOf(groupId, recurringId, patch.split))
          : []),
        ...(skipThisMonth ? skipThisMonthStatements(db, token, groupId, recurringId, thisMonth, now) : []),
      ],
    };
  });

  return outcome.status === 'written' ? json(outcome.value) : failureResponse(outcome);
}

// ---------------------------------------------------------------------------
// DELETE /recurring-expenses/:id

/**
 * 一度も支出を作っていない(生成記録が無い)固定費だけ、物理削除できる。作った支出と生成記録が参照するので、一度でも
 * 作った固定費は消せない(止める・終了月を決める)。間違えて作った固定費が、上限(50件)と通貨のロックに残り続けないように。
 * 生成記録は、支出と同じ書き込みで作る(自動登録)ので、生成記録が無ければ、参照する支出も無い。
 */
export async function handleDeleteRecurring(
  request: Request,
  env: Env,
  now: number,
  recurringId: string,
): Promise<Response> {
  const session = await authenticateRequest(request, env.DB, now);
  if (session === null) return unauthorized();
  const db = env.DB;

  const groupId = await findRecurringGroup(db, recurringId);
  if (groupId === null) return notFound();

  const outcome = await writeToGroupWithRetry<null, Response>(db, groupId, async () => {
    const access = await loadGroupAccess(db, session.userId, groupId);
    if (access === null) return { reject: notFound() };
    const [current, run] = await Promise.all([
      db
        .prepare('SELECT 1 AS found FROM recurring_expenses WHERE id = ? AND group_id = ?')
        .bind(recurringId, groupId)
        .first<{ found: number }>(),
      db
        .prepare('SELECT 1 AS found FROM recurring_expense_runs WHERE recurring_expense_id = ? LIMIT 1')
        .bind(recurringId)
        .first<{ found: number }>(),
    ]);
    if (current === null) return { reject: notFound() };
    if (!canEditGroupSettings(access, now)) return { reject: forbidden() };
    // 自動登録が、読んだあとに作れば、バージョンが上がっていて、ここに来ない(競合として、読み直して判定し直す)。
    if (run !== null) return { reject: conflict('recurring_expense_in_use') };

    return {
      value: null,
      // 負担設定(子)から先に消す。
      write: (token) => [
        deleteAllocationsStatement(db, token, groupId, recurringId),
        db
          .prepare(`DELETE FROM recurring_expenses WHERE id = ? AND group_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`)
          .bind(recurringId, groupId, groupId, token),
      ],
    };
  });

  return outcome.status === 'written' ? noContent() : failureResponse(outcome);
}
