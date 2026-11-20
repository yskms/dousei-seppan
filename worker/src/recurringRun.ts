// 固定費の自動登録(Cronの1時間ごとの処理の一部)。設計は docs/backend-design.md 7章。
//
// - 作るのは、グループの「今月」(グループのタイムゾーン)の分だけ。予定日(`day_of_month`。その月に無い日は月末日)に
//   達したら、支出を作る。過去の月の分は、Cronが止まっていても、あとから作らない。
// - 登録先の月は、今月が未締めなら今月。早めに締められていれば、最も古い未締めの月(通常は翌月)。日付は予定日のまま。
// - 二重に作らないのは、`recurring_expense_runs` の主キー(固定費, 予定の月)。作った支出をユーザーが消しても、
//   行は残り、作り直さない。
// - 書き込みは、グループごとに1回の `writeToGroup`(バージョンを1つ上げる)。読み込みは、バージョンを読んだ**あと**
//   (8章)。候補を探す最初の1回は、どのグループを調べるかを決めるだけで、書く内容には使わない。
// - 'version'(利用者の操作との競合)は、やり直さず、次の回に回す。同じ処理を何度動かしても、結果は変わらない(冪等)。
import { buildAllocations, isMemberAvailable, loadMembers, splitMemberRefs, type MemberRow } from './expenses.ts';
import { insertRowsGuarded, readDataVersion, statementsForRows, writeToGroup } from './groupWrite.ts';
import { dateIn, monthIn, recurringTargetMonth, scheduledDate } from './months.ts';
import { splitFromRows, type RecurringAllocationRow, type SplitMethod } from './recurring.ts';

/**
 * 1つのグループで、固定費を1件でも作れる最小の費用の見積もり(これだけ予算が残っていなければ、グループに手を付けない)。
 * 読み込み5(版・固定費・負担設定・メンバー・締めた月)と、最小の書き込み(バージョン・支出・負担額・生成記録で4)と、
 * 一意制約違反のときの確認1回に、余裕を足した値。**実際の費用の見積もりではない。** 書く文の数は、固定費の数と
 * メンバーの数で増える(個別の負担は「固定費 × メンバー」行)ので、グループごとに、読んだあとで書く文の数を数え、
 * 残りの予算に収まる件数だけを作る(残りは次の回。`registerForGroup`)。
 */
export const ESTIMATED_QUERIES_PER_RECURRING_GROUP = 12;

export interface RecurringRunSummary {
  /** 支出を作ったグループ。 */
  createdGroups: string[];
  /** 作った支出の数。 */
  createdExpenses: number;
  /** 利用者の操作と競合した(または、他の回が先に作った)ので、次の回に回したグループ(何も変更していない)。 */
  deferredGroups: string[];
  /** 想定外のエラーで作れなかったグループ。 */
  failedGroups: string[];
  /**
   * 予算が尽きて、この回は手を付けなかったグループ。予算に収まらず、固定費の一部だけ作って、残りを次の回に回した
   * グループも入る(`createdGroups` にも入る)。
   */
  postponedGroups: string[];
  /**
   * 作れなかった固定費(負担設定が合わない、など。あってはならない不整合)。その固定費だけ飛ばして、同じグループの
   * ほかの固定費は作る。ログに残し、定期処理は最後に失敗として投げる(気づけるように)。
   */
  invalidTemplates: string[];
  /** 予算が尽きて、この処理そのものを見送ったか(候補を探す1回も使わなかった)。 */
  skipped: boolean;
  /** この処理が使ったD1のクエリ数。 */
  queries: number;
}

interface CandidateRow {
  id: string;
  group_id: string;
  day_of_month: number;
  start_month: string;
  end_month: string | null;
  timezone: string;
  category_archived: number;
  ran_a: number;
  ran_b: number;
}

interface TemplateRow {
  id: string;
  description: string | null;
  amount_minor: number;
  category_id: string;
  payer_member_id: string;
  split_method: SplitMethod;
  day_of_month: number;
  start_month: string;
  end_month: string | null;
  timezone: string;
  category_archived: number;
  ran_a: number;
  ran_b: number;
}

/**
 * 止まっていない固定費を、グループとタイムゾーン、費目のアーカイブ、「今月の分を作り済みか」と一緒に読む。
 * 作り済みかは、世界のどのタイムゾーンでも「今月」が `a` か `b` のどちらかなので、その2か月について、生成記録の
 * 主キー(固定費, 予定の月)で引く。`{group}` は、グループを絞る条件(候補を探すときは無し)。
 */
export const dueTemplatesSql = (groupFilter: boolean) => `
  SELECT r.id AS id, r.group_id AS group_id, r.description AS description, r.amount_minor AS amount_minor,
         r.category_id AS category_id, r.payer_member_id AS payer_member_id, r.split_method AS split_method,
         r.day_of_month AS day_of_month, r.start_month AS start_month, r.end_month AS end_month,
         g.timezone AS timezone, c.archived_at IS NOT NULL AS category_archived,
         EXISTS (SELECT 1 FROM recurring_expense_runs u WHERE u.recurring_expense_id = r.id AND u.scheduled_month = ?1) AS ran_a,
         EXISTS (SELECT 1 FROM recurring_expense_runs u WHERE u.recurring_expense_id = r.id AND u.scheduled_month = ?2) AS ran_b
    FROM recurring_expenses r
    JOIN expense_groups g ON g.id = r.group_id
    JOIN categories c ON c.id = r.category_id AND c.group_id = r.group_id
   WHERE r.paused_at IS NULL AND r.start_month <= ?2 AND (r.end_month IS NULL OR r.end_month >= ?1)
     ${groupFilter ? 'AND r.group_id = ?3' : ''}`;

const HOUR_MS = 60 * 60 * 1000;

/** 世界のどのタイムゾーン(UTC-12〜UTC+14)でも、「今月」は、この2か月のどちらか。 */
function candidateMonths(now: number): { a: string; b: string } {
  return { a: monthIn('UTC', now - 12 * HOUR_MS), b: monthIn('UTC', now + 14 * HOUR_MS) };
}

interface DueTemplate<T extends CandidateRow | TemplateRow> {
  template: T;
  /** 予定の月(グループの今月)。 */
  scheduledMonth: string;
  expenseDate: string;
}

/** 今月の分を作る時期に来ていて、まだ作っていない固定費か(費目のアーカイブも見る)。 */
function dueOf<T extends CandidateRow | TemplateRow>(
  template: T,
  months: { a: string; b: string },
  now: number,
): DueTemplate<T> | null {
  const scheduledMonth = monthIn(template.timezone, now);
  if (scheduledMonth !== months.a && scheduledMonth !== months.b) return null; // 範囲外のタイムゾーン(あり得ない)
  if (scheduledMonth < template.start_month) return null;
  if (template.end_month !== null && scheduledMonth > template.end_month) return null;
  if ((scheduledMonth === months.a ? template.ran_a : template.ran_b) !== 0) return null;
  // アーカイブした費目の固定費は、止めずに、自動登録だけを見送る(費目を戻すか選び直すと、作られる)。
  if (template.category_archived !== 0) return null;
  const expenseDate = scheduledDate(scheduledMonth, template.day_of_month);
  if (dateIn(template.timezone, now) < expenseDate) return null;
  return { template, scheduledMonth, expenseDate };
}

/** 作る時期に来ている固定費があるグループ(グループのID順)。 */
async function findGroupsWithDueTemplates(db: D1Database, now: number): Promise<string[]> {
  const months = candidateMonths(now);
  const { results } = await db.prepare(dueTemplatesSql(false)).bind(months.a, months.b).all<CandidateRow>();
  return [...new Set(results.filter((row) => dueOf(row, months, now) !== null).map((row) => row.group_id))].sort();
}

type GroupResult = 'created' | 'nothing' | 'deferred' | 'postponed';

interface GroupOutcome {
  result: GroupResult;
  createdExpenses: number;
  /** 作る時期に来ていたが、予算に収まらず、次の回に回した固定費の数。 */
  remaining: number;
  invalidTemplates: string[];
  /** この処理が使ったクエリ数。 */
  queries: number;
}

const EXPENSE_COLUMNS = [
  'id',
  'group_id',
  'expense_date',
  'target_month',
  'description',
  'amount_minor',
  'category_id',
  'payer_member_id',
  'created_by_member_id',
  'split_method',
  'recurring_expense_id',
  'created_at',
  'updated_at',
];
const ALLOCATION_COLUMNS = ['group_id', 'expense_id', 'member_id', 'burden_minor', 'share_basis_points'];
const RUN_COLUMNS = ['group_id', 'recurring_expense_id', 'scheduled_month', 'expense_id', 'created_at'];

/** 支払者・負担の対象の全員が、その月に使えるか(支出の登録と同じ。expenses.ts の `isMemberAvailable`)。 */
function allAvailable(members: Map<string, MemberRow>, memberIds: readonly string[], month: string): boolean {
  return memberIds.every((id) => {
    const member = members.get(id);
    return member !== undefined && isMemberAvailable(member, month);
  });
}

type Row = (string | number | null)[];

/** 1つの固定費から作る行。 */
interface Bundle {
  recurringId: string;
  scheduledMonth: string;
  expense: Row;
  burdens: Row[];
  run: Row;
}

/** 書く文の数(バージョンを上げる1文を含む)に、一意制約違反のときの確認1回を足した、最悪のクエリ数。 */
function writeCost(bundles: readonly Bundle[]): number {
  const burdens = bundles.reduce((sum, bundle) => sum + bundle.burdens.length, 0);
  return (
    1 +
    statementsForRows(EXPENSE_COLUMNS.length, bundles.length) +
    statementsForRows(ALLOCATION_COLUMNS.length, burdens) +
    statementsForRows(RUN_COLUMNS.length, bundles.length) +
    1
  );
}

/**
 * 1つのグループの、作る時期に来ている固定費を、1回の書き込みで作る。`queriesLeft` は、この回の残りの予算。
 * バージョンを先に読み、そのあとで固定費・メンバー・締めた月を読む(8章)。
 *
 * 書く文の数は、固定費の数 × メンバーの数で増える(個別の負担は1行ずつ)。読んだあとで数え、残りの予算に収まる
 * 件数(固定費のID順の先頭から)だけ作る。収まらない固定費は、生成記録が無いままなので、次の回が作る。
 */
async function registerForGroup(
  db: D1Database,
  groupId: string,
  now: number,
  queriesLeft: number,
): Promise<GroupOutcome> {
  let queries = 0;
  const nothing = (result: GroupResult, invalidTemplates: string[] = [], remaining = 0): GroupOutcome => ({
    result,
    createdExpenses: 0,
    remaining,
    invalidTemplates,
    queries,
  });
  const version = await readDataVersion(db, groupId);
  queries += 1;
  if (version === null) return nothing('nothing');

  const months = candidateMonths(now);
  const [templates, allocations, members, closed] = await Promise.all([
    db.prepare(dueTemplatesSql(true)).bind(months.a, months.b, groupId).all<TemplateRow>(),
    db
      .prepare(
        `SELECT recurring_expense_id, member_id, share_basis_points, amount_minor FROM recurring_expense_allocations
          WHERE group_id = ? ORDER BY recurring_expense_id, member_id`,
      )
      .bind(groupId)
      .all<RecurringAllocationRow>(),
    loadMembers(db, groupId),
    db
      .prepare('SELECT max(target_month) AS month FROM monthly_closings WHERE group_id = ?')
      .bind(groupId)
      .first<{ month: string | null }>(),
  ]);
  queries += 4;

  const byTemplate = new Map<string, RecurringAllocationRow[]>();
  for (const row of allocations.results) {
    const list = byTemplate.get(row.recurring_expense_id) ?? [];
    list.push(row);
    byTemplate.set(row.recurring_expense_id, list);
  }
  const latestClosed = closed?.month ?? null;

  const bundles: Bundle[] = [];
  const invalidTemplates: string[] = [];
  const due = templates.results
    .map((template) => dueOf(template, months, now))
    .filter((item): item is DueTemplate<TemplateRow> => item !== null)
    .sort((x, y) => (x.template.id < y.template.id ? -1 : x.template.id > y.template.id ? 1 : 0));
  for (const { template, scheduledMonth, expenseDate } of due) {
    const targetMonth = recurringTargetMonth(scheduledMonth, latestClosed);
    try {
      const split = splitFromRows(template.split_method, byTemplate.get(template.id) ?? []);
      // 負担額は、支出の登録と同じ関数で計算する(金額指定の合計の検査も同じ)。合わなければ、保存した設定の不整合。
      const built = buildAllocations(template.amount_minor, split);
      if (!built.ok) throw new Error(`固定費の負担設定が金額と合わない: ${built.field}`);

      // 使えないメンバーがいれば、今回は作らない(記録も残さない)。脱退の確定が済めば、固定費は止まる(`payer_left`・
      // `member_changed`)。確定のCronより先にここへ来ても、脱退した人の支出を作らない。
      const memberIds = [template.payer_member_id, ...splitMemberRefs(split).map((ref) => ref.id)];
      if (!allAvailable(members, memberIds, targetMonth)) continue;

      const expenseId = crypto.randomUUID();
      bundles.push({
        recurringId: template.id,
        scheduledMonth,
        expense: [
          expenseId,
          groupId,
          expenseDate,
          targetMonth,
          template.description,
          template.amount_minor,
          template.category_id,
          template.payer_member_id,
          // 自動登録は、誰かが登録したものではない。支払者が登録した扱いにする(登録者は必須の列)。
          template.payer_member_id,
          template.split_method,
          template.id,
          now,
          now,
        ],
        burdens: built.allocations.map((item) => [groupId, expenseId, item.memberId, item.burdenMinor, item.shareBasisPoints]),
        run: [groupId, template.id, scheduledMonth, expenseId, now],
      });
    } catch (error) {
      // 不整合のある固定費だけ飛ばす(ほかの固定費は作る)。値(名前・金額など)はログに出さない。
      console.error('固定費の自動登録を飛ばした', groupId, template.id, error instanceof Error ? error.name : 'unknown');
      invalidTemplates.push(template.id);
    }
  }
  if (bundles.length === 0) return nothing('nothing', invalidTemplates);

  // 残りの予算に収まる件数だけ作る。1件も収まらなければ、このグループは次の回に回す(読み込みの分だけ使った)。
  let take = bundles.length;
  while (take > 0 && queries + writeCost(bundles.slice(0, take)) > queriesLeft) take -= 1;
  if (take === 0) return nothing('postponed', invalidTemplates, bundles.length);
  const chosen = bundles.slice(0, take);
  const remaining = bundles.length - take;

  // 支出 → 負担額 → 生成記録の順(外部キー)。
  let statementCount = 0;
  const written = await writeToGroup(db, groupId, version, (token) => {
    const statements = [
      ...insertRowsGuarded(db, token, groupId, 'expenses', EXPENSE_COLUMNS, chosen.map((bundle) => bundle.expense)),
      ...insertRowsGuarded(db, token, groupId, 'expense_allocations', ALLOCATION_COLUMNS, chosen.flatMap((bundle) => bundle.burdens)),
      ...insertRowsGuarded(db, token, groupId, 'recurring_expense_runs', RUN_COLUMNS, chosen.map((bundle) => bundle.run)),
    ];
    statementCount = statements.length;
    return statements;
  });
  queries += 1 + statementCount; // バージョンを上げる文 + 書く文

  if (written.ok) return { result: 'created', createdExpenses: chosen.length, remaining, invalidTemplates, queries };
  if (written.reason === 'version') return nothing('deferred', invalidTemplates);

  // 'unique': 同じ(固定費, 予定の月)の生成記録が**ある**ことを読んで確かめる。無ければ、別の原因(後続のSQLへの
  // GROUP_WRITE_GUARD の付け忘れなど、実装の誤り)なので、作成済みとして正常にせず、エラーにする(7章)。
  // 全体が取り消されているので、何も作られていない。記録の無い固定費は、次の回が作る。
  // 同じグループの固定費の予定の月は、すべて同じ(タイムゾーンが同じ)。束縛の上限(100)に収めるため、月は1つにする。
  const found = await db
    .prepare(
      `SELECT count(*) AS n FROM recurring_expense_runs
        WHERE group_id = ? AND scheduled_month = ? AND recurring_expense_id IN (${chosen.map(() => '?').join(', ')})`,
    )
    .bind(groupId, chosen[0]!.scheduledMonth, ...chosen.map((bundle) => bundle.recurringId))
    .first<{ n: number }>();
  queries += 1;
  if ((found?.n ?? 0) === 0) throw new Error('固定費の自動登録で、生成記録が無いのに一意制約に違反した');
  return nothing('deferred', invalidTemplates);
}

/**
 * 固定費の自動登録。`usedQueries` は、この回がすでに使ったD1のクエリ数、`queryBudget` は1回の実行の予算(cron.ts)。
 * 候補を探す1回と、グループごとの書き込みが予算に収まる範囲で、グループのID順に処理する。
 * 予算に収まらないグループ(や固定費)は、`postponedGroups` として次の回に回す(1時間後。予定日の当日中に作られる)。
 * 1つのグループの失敗で、ほかのグループを止めない(`failedGroups` に入れる。投げるのは呼び出し側)。
 */
export async function registerDueRecurring(
  db: D1Database,
  now: number,
  usedQueries: number,
  queryBudget: number,
): Promise<RecurringRunSummary> {
  const summary: RecurringRunSummary = {
    createdGroups: [],
    createdExpenses: 0,
    deferredGroups: [],
    failedGroups: [],
    postponedGroups: [],
    invalidTemplates: [],
    skipped: false,
    queries: 0,
  };
  // 候補を探す1回と、1グループ分が収まらなければ、この回は見送る(脱退の確定を優先する)。
  if (usedQueries + 1 + ESTIMATED_QUERIES_PER_RECURRING_GROUP > queryBudget) {
    summary.skipped = true;
    return summary;
  }
  const groupIds = await findGroupsWithDueTemplates(db, now);
  summary.queries += 1;

  for (const groupId of groupIds) {
    const left = queryBudget - usedQueries - summary.queries;
    if (left < ESTIMATED_QUERIES_PER_RECURRING_GROUP) {
      summary.postponedGroups.push(groupId);
      continue;
    }
    try {
      const outcome = await registerForGroup(db, groupId, now, left);
      summary.queries += outcome.queries;
      summary.invalidTemplates.push(...outcome.invalidTemplates);
      if (outcome.result === 'created') {
        summary.createdGroups.push(groupId);
        summary.createdExpenses += outcome.createdExpenses;
      }
      if (outcome.result === 'deferred') summary.deferredGroups.push(groupId);
      if (outcome.result === 'postponed' || (outcome.result === 'created' && outcome.remaining > 0)) {
        summary.postponedGroups.push(groupId);
      }
    } catch (error) {
      // 値(名前・金額など)はログに出さない。
      console.error('固定費の自動登録に失敗', groupId, error instanceof Error ? error.name : 'unknown');
      summary.failedGroups.push(groupId);
      // 失敗した分のクエリ数は分からないので、1グループの最小の費用と同じだけ使ったものとして、予算を減らす。
      summary.queries += ESTIMATED_QUERIES_PER_RECURRING_GROUP;
    }
  }
  return summary;
}
