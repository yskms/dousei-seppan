// グループ内データの書き込みの競合制御。設計は docs/backend-design.md 8章。
//
// D1には対話的トランザクションがなく、`batch()` 単位でのみアトミック。そこで、グループ単位の
// 楽観ロック（expense_groups.data_version と write_token）で、同時に書いた別のリクエストを検出する。
//
// 1. 呼び出し側が data_version（v）を読み、検証と計算をする。
// 2. このファイルの writeToGroup が、batch の最初に `data_version = v` のときだけバージョンを上げて
//    リクエスト固有の token を書く。
// 3. 後続のSQLは、`expense_groups.write_token` が自分の token と一致するときだけ効くようにする
//    （GROUP_WRITE_GUARD を使う）。
//
// 後続の条件を `data_version = v + 1` に「簡略化」してはいけない。同じ v を読んだ別のリクエストが先に
// 確定すると、バージョンは v + 1 になっているため、負けた側の後続SQLまで実行されてしまう
// （test/groupWrite.test.ts の「簡略化した条件では…」が、その実例）。

/**
 * 後続のSQLに付ける条件のSELECT。`WHERE EXISTS (${GROUP_WRITE_GUARD})` の形で使い、
 * バインドは (groupId, token) の順。INSERTは `INSERT ... SELECT ... WHERE EXISTS (...)`、
 * UPDATE・DELETEは `... AND EXISTS (...)` にする。
 */
export const GROUP_WRITE_GUARD = 'SELECT 1 FROM expense_groups WHERE id = ? AND write_token = ?';

export type GroupWriteResult =
  /** 書き込めた。results は、バージョンを上げるSQLを除いた、build が返したSQLの結果（順番どおり）。 */
  | { ok: true; token: string; results: D1Result[] }
  /**
   * 競合した。他のリクエストが先に書いた（または、グループが無い、一意制約に違反した）。
   * 何も変更されていない。読み直してやり直すか、409を返すかは、呼び出し側が決める（8章）。
   */
  | { ok: false; reason: 'conflict' };

/** グループの現在の data_version。グループが無ければ null。 */
export async function readDataVersion(db: D1Database, groupId: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT data_version FROM expense_groups WHERE id = ?')
    .bind(groupId)
    .first<{ data_version: number }>();
  return row === null ? null : row.data_version;
}

/**
 * グループ内のデータを、`expectedVersion` を読んだ時点から変わっていないときだけ書き込む。
 *
 * @param build リクエスト固有の token を受け取り、書き込みのSQLを返す。各SQLは GROUP_WRITE_GUARD の
 *   条件を付けること（付け忘れたSQLは、競合しても実行されてしまう）。
 */
export async function writeToGroup(
  db: D1Database,
  groupId: string,
  expectedVersion: number,
  build: (token: string) => D1PreparedStatement[],
): Promise<GroupWriteResult> {
  const token = crypto.randomUUID();
  const bump = db
    .prepare(
      `UPDATE expense_groups SET data_version = data_version + 1, write_token = ?
        WHERE id = ? AND data_version = ?`,
    )
    .bind(token, groupId, expectedVersion);

  let results: D1Result[];
  try {
    results = await db.batch([bump, ...build(token)]);
  } catch (error) {
    // 一意制約違反（二重締めなど）は、batch 全体がロールバックされる。競合として扱う。
    // それ以外（CHECK・外部キー違反など）は実装の誤りなので、握りつぶさずに投げる。
    if (isUniqueViolation(error)) return { ok: false, reason: 'conflict' };
    throw error;
  }

  // 0件なら、他のリクエストが先に書いている。後続のSQLも条件を満たさず、何も変更されていない。
  if (results[0].meta.changes === 0) return { ok: false, reason: 'conflict' };
  return { ok: true, token, results: results.slice(1) };
}

function isUniqueViolation(error: unknown): boolean {
  // D1のエラーは、SQLiteのメッセージ（"UNIQUE constraint failed: ..."）を含む文字列で届く。
  // 主キーの重複も、このメッセージになる。
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
