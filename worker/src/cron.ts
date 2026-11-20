// 定期処理（Cron Triggers）。設計は docs/backend-design.md 7章。1時間ごとに動かし、グループのタイムゾーンで日付を
// 判定する。処理はすべて冪等（同じ時刻に2回動いても、結果が変わらない）。
//
// いま入っているのは、月初の処理（脱退月が終わったのに締められていない脱退の確定。5章）。固定費の自動登録は、
// 固定費のAPIと一緒に足す（7章）。
import { latestClosedMonth } from './access.ts';
import { markLeftStatement } from './closedMonth.ts';
import { readDataVersion, writeToGroup } from './groupWrite.ts';
import {
  confirmLeaveStatements,
  deleteGroupStatements,
  dueLeaves,
  isLastMember,
  loadCategoryIds,
  loadMembers,
} from './membership.ts';
import { monthIn } from './months.ts';

/**
 * 1回の実行で確定させるグループの数の上限。D1のクエリ数（Freeは1回の呼び出しにつき50）と、1回の実行の長さを
 * 抑えるため。残りは、次の時間の実行が引き受ける（APIは、脱退月が終わったメンバーを、確定したものとして扱う。
 * access.ts の `isLeaveEffective`）ので、遅れても利用者の見える挙動は変わらない。公開時にPaidへ移すときに見直す。
 */
export const MAX_GROUPS_PER_RUN = 20;

export interface CronSummary {
  /** 脱退を確定させたグループ。 */
  confirmedGroups: string[];
  /** 他の書き込みと競合したので、次の回に回したグループ（何も変更していない）。 */
  deferredGroups: string[];
  /** 想定外のエラーで確定できなかったグループ。 */
  failedGroups: string[];
}

/**
 * 脱退を選んだままのメンバーを引く検索。部分索引（idx_group_members_leave_requested）を使う。`GROUP BY` や
 * `ORDER BY group_id` を足すと、プランナーが、索引でなく全メンバーの走査を選ぶ（test/cron.test.ts で、索引を使うことを確かめている）。
 * グループごとのまとめと並べ替えは、JSで行う。
 */
export const DUE_LEAVES_SQL = `SELECT m.group_id AS group_id, g.timezone AS timezone, m.leave_requested_month AS month
     FROM group_members m JOIN expense_groups g ON g.id = m.group_id
    WHERE m.status = 'active' AND m.leave_requested_month IS NOT NULL`;

/** 脱退を選んだ月が終わっている（グループの今月より前の）メンバーがいるグループ。古い月のものから。 */
async function findGroupsWithDueLeaves(db: D1Database, now: number): Promise<string[]> {
  const { results } = await db.prepare(DUE_LEAVES_SQL).all<{ group_id: string; timezone: string; month: string }>();
  // 今月かどうかは、グループのタイムゾーンで決める。SQLでは決められないので、ここで絞る。
  const oldest = new Map<string, string>();
  for (const row of results) {
    if (row.month >= monthIn(row.timezone, now)) continue;
    const known = oldest.get(row.group_id);
    if (known === undefined || row.month < known) oldest.set(row.group_id, row.month);
  }
  return [...oldest.entries()]
    .sort(([idA, monthA], [idB, monthB]) => (monthA === monthB ? (idA < idB ? -1 : 1) : monthA < monthB ? -1 : 1))
    .map(([groupId]) => groupId);
}

type GroupResult = 'confirmed' | 'deferred' | 'nothing';

/** 1つのグループの、月が終わった脱退を確定させる。バージョンを先に読み、そのあとでデータを読む（8章）。 */
async function confirmDueLeavesInGroup(db: D1Database, groupId: string, now: number): Promise<GroupResult> {
  const version = await readDataVersion(db, groupId);
  if (version === null) return 'nothing';
  const group = await db
    .prepare('SELECT timezone FROM expense_groups WHERE id = ?')
    .bind(groupId)
    .first<{ timezone: string }>();
  if (group === null) return 'nothing';
  const members = await loadMembers(db, groupId);
  // グループの今月より前の月を脱退月に選んだメンバー（月が終わったもの）。
  const currentMonth = monthIn(group.timezone, now);
  const due = dueLeaves(members, currentMonth).filter((member) => member.leaveRequestedMonth! < currentMonth);
  if (due.length === 0) return 'nothing';
  // 最後の1人の脱退は、確定と同時に、グループのデータをすべて消す（5章「グループの削除」）。
  const lastMember = isLastMember(members, due);
  const categoryIds = lastMember ? [] : await loadCategoryIds(db, groupId);
  const closedThrough = lastMember ? null : await latestClosedMonth(db, groupId);

  const written = await writeToGroup(db, groupId, version, (token) =>
    lastMember
      ? deleteGroupStatements(db, token, groupId)
      : [
          ...confirmLeaveStatements(db, token, groupId, now, members, due, categoryIds, closedThrough),
          // 脱退月がすでに締められていれば、送金が済んでいるメンバーは、そのまま脱退済みになる。
          markLeftStatement(
            db,
            token,
            groupId,
            now,
            due.map((member) => member.id),
          ),
        ],
  );
  if (written.ok) return 'confirmed';
  // 'version': 利用者の操作と競合した。やり直さず、次の時間に回す（Cronは1時間ごとで冪等）。
  if (written.reason === 'version') return 'deferred';
  // 'unique': 確定の書き込みには、一意制約に触れる文が無い。出たら実装の誤りなので、握りつぶさない。
  throw new Error('脱退の確定で、想定外の一意制約違反');
}

/** 1時間ごとの定期処理。`now` は予定の時刻（Unixエポックのミリ秒）。失敗したグループがあれば、最後に投げる。 */
export async function runScheduled(env: Env, now: number): Promise<CronSummary> {
  const summary: CronSummary = { confirmedGroups: [], deferredGroups: [], failedGroups: [] };
  const groupIds = (await findGroupsWithDueLeaves(env.DB, now)).slice(0, MAX_GROUPS_PER_RUN);
  for (const groupId of groupIds) {
    try {
      const result = await confirmDueLeavesInGroup(env.DB, groupId, now);
      if (result === 'confirmed') summary.confirmedGroups.push(groupId);
      if (result === 'deferred') summary.deferredGroups.push(groupId);
    } catch (error) {
      // 1つのグループの失敗で、ほかのグループを止めない。値（名前・金額など）はログに出さない。
      console.error('脱退の確定に失敗', groupId, error instanceof Error ? error.name : 'unknown');
      summary.failedGroups.push(groupId);
    }
  }
  if (summary.failedGroups.length > 0) {
    throw new Error(`定期処理で失敗したグループがある: ${summary.failedGroups.length}件`);
  }
  return summary;
}
