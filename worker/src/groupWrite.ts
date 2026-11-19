// グループ内データの書き込みの競合制御。設計は docs/backend-design.md 8章。
//
// D1には対話的トランザクションがなく、`batch()` 単位でのみアトミック。そこで、グループ単位の
// 楽観ロック（expense_groups.data_version と write_token）で、同時に書いた別のリクエストを検出する。
//
// 1. 呼び出し側が data_version（v）を読み、そのあとで検証と計算に使うデータを読む（順序は下の注意）。
// 2. このファイルの writeToGroup が、batch の最初に `data_version = v` のときだけバージョンを上げて
//    リクエスト固有の token を書く。
// 3. 後続のSQLは、`expense_groups.write_token` が自分の token と一致するときだけ効くようにする
//    （GROUP_WRITE_GUARD を使う）。
//
// 注意1: バージョンは、計算に使うデータより「先に」読む。データを先に読み、あとでバージョンを読むと、
// その間に入った別の書き込みの新しいバージョンと、古いデータを組み合わせてしまう。楽観ロックは通るので、
// 別のリクエストの更新を黙って上書きする（lost update）。先にバージョンを読めば、間に書き込みが入った
// 場合はバージョンが合わず、競合として検出される（test/groupWrite.test.ts の「読む順序」）。
//
// 注意2: 後続の条件を `data_version = v + 1` に「簡略化」してはいけない。同じ v を読んだ別のリクエストが
// 先に確定すると、バージョンは v + 1 になっているため、負けた側の後続SQLまで実行されてしまう
// （test/groupWrite.test.ts の「簡略化した条件では…」が、その実例）。
//
// 注意3: 1つのグループへの書き込み用。複数のグループにまたがる書き込み（アカウント削除）は未決
// （docs/backend-design.md 12章）。

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
   * バージョンが合わない。他のリクエストが先に書いた（グループが無い場合も、ここに来る）。
   * 何も変更されていない。読み直してやり直せる。やり直すか409にするかは呼び出し側が決める（8章）。
   */
  | { ok: false; reason: 'version' }
  /**
   * 一意制約に違反した（二重締め、すでに参加している、固定費の作成済み、など）。batch 全体（バージョンの
   * 更新も含む）が取り消され、何も変更されていない。バージョンは合っていた（合っていなければ、後続のSQLは
   * 実行されず、一意制約には触れない）ので、読み直しても同じ結果になる。やり直さない。
   * 業務上どう扱うか（APIなら409、Cronの固定費なら作成済みとして正常）は、呼び出し側が決める。
   */
  | { ok: false; reason: 'unique' };

/**
 * グループの現在の data_version。グループが無ければ null。
 * 書き込みに使うデータを読む「前に」呼ぶこと（ファイル冒頭の注意1）。
 */
export async function readDataVersion(db: D1Database, groupId: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT data_version FROM expense_groups WHERE id = ?')
    .bind(groupId)
    .first<{ data_version: number }>();
  return row === null ? null : row.data_version;
}

/**
 * グループ内のデータを、`expectedVersion` を読んだ時点から変わっていないときだけ書き込む。
 * `expectedVersion` は、検証・計算に使うデータより先に読んだもの（ファイル冒頭の注意1）。
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
    // 一意制約違反は、batch 全体がロールバックされる。バージョンの競合とは区別して返す。
    // それ以外（CHECK・外部キー違反など）は実装の誤りなので、握りつぶさずに投げる。
    if (isUniqueViolation(error)) return { ok: false, reason: 'unique' };
    throw error;
  }

  // 0件なら、他のリクエストが先に書いている。後続のSQLも条件を満たさず、何も変更されていない。
  if (results[0].meta.changes === 0) return { ok: false, reason: 'version' };
  return { ok: true, token, results: results.slice(1) };
}

/**
 * 一意制約違反（主キーの重複を含む）かどうか。判定はエラーのメッセージ頼み。
 *
 * D1のエラーは、`D1_ERROR: UNIQUE constraint failed: <表>.<列>: SQLITE_CONSTRAINT ...` という
 * メッセージで届き、SQLiteの元のメッセージが `cause` にも入る（ローカルD1で確認。本番D1も同じ形かは、
 * 公開前に確認する。docs/backend-design.md 13章の9）。どちらに入っていても拾えるよう、`cause` をたどる。
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    const message = typeof current === 'string' ? current : current instanceof Error ? current.message : '';
    if (/UNIQUE constraint failed/i.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
