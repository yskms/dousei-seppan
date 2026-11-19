/// <reference types="node" />
// グループ内データの書き込みの競合制御（src/groupWrite.ts）の検査。設計は docs/backend-design.md 8章。
// ローカルD1（miniflare）での検査なので、確かめるのはSQLと batch の振る舞い（ロジック）。ローカルD1は
// batch を直列に実行するため、並行して走ったときの性質や、本番D1のエラーの形は確かめていない。
// それらは、公開前に Workers の実環境で確認する（docs/backend-design.md 13章の9）。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GROUP_WRITE_GUARD, isUniqueViolation, readDataVersion, writeToGroup } from '../src/groupWrite.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';

describe('グループ単位の楽観ロック（8章）', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
  });
  after(async () => {
    await local.dispose();
  });

  const run = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run();

  interface Fixture {
    groupId: string;
    memberId: string;
    categoryId: string;
  }
  /** 支出を書ける最小のグループ（メンバー1人と費目1つ）。 */
  const addGroup = async (): Promise<Fixture> => {
    const groupId = id('group');
    const memberId = id('member');
    const categoryId = id('category');
    await run(
      `INSERT INTO expense_groups (id, name, currency_code, currency_minor_unit, timezone, created_at)
       VALUES (?, 'ふたりの生活費', 'JPY', 0, 'Asia/Tokyo', 1)`,
      groupId,
    );
    await run(
      `INSERT INTO group_members (id, group_id, display_name, color, history_from_month, joined_at)
       VALUES (?, ?, 'あなた', 'pink', '2026-11', 1)`,
      memberId,
      groupId,
    );
    await run(
      `INSERT INTO categories (id, group_id, name, icon, color, created_at) VALUES (?, ?, '食費', 'cart', 'blue', 1)`,
      categoryId,
      groupId,
    );
    return { groupId, memberId, categoryId };
  };

  // 8章の形（INSERT ... SELECT ... WHERE EXISTS、UPDATE・DELETE は AND EXISTS）で、条件を付けたSQL。
  const insertExpense = (f: Fixture, token: string, expenseId: string, amount = 4280) =>
    db
      .prepare(
        `INSERT INTO expenses (id, group_id, expense_date, target_month, amount_minor, category_id,
           payer_member_id, created_by_member_id, split_method, created_at, updated_at)
         SELECT ?, ?, '2026-11-19', '2026-11', ?, ?, ?, ?, 'category', 1, 1
          WHERE EXISTS (${GROUP_WRITE_GUARD})`,
      )
      .bind(expenseId, f.groupId, amount, f.categoryId, f.memberId, f.memberId, f.groupId, token);
  const updateExpense = (f: Fixture, token: string, expenseId: string, amount: number) =>
    db
      .prepare(
        `UPDATE expenses SET amount_minor = ?, updated_at = 2
          WHERE id = ? AND group_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`,
      )
      .bind(amount, expenseId, f.groupId, f.groupId, token);
  const deleteExpense = (f: Fixture, token: string, expenseId: string) =>
    db
      .prepare(`DELETE FROM expenses WHERE id = ? AND group_id = ? AND EXISTS (${GROUP_WRITE_GUARD})`)
      .bind(expenseId, f.groupId, f.groupId, token);
  const insertClosing = (f: Fixture, token: string, closingId: string) =>
    db
      .prepare(
        `INSERT INTO monthly_closings (id, group_id, target_month, currency_code, currency_minor_unit,
           data_version, closed_by_member_id, closed_at)
         SELECT ?, ?, '2026-11', 'JPY', 0, 1, ?, 1
          WHERE EXISTS (${GROUP_WRITE_GUARD})`,
      )
      .bind(closingId, f.groupId, f.memberId, f.groupId, token);

  const expenseAmount = async (expenseId: string) =>
    (await db.prepare('SELECT amount_minor FROM expenses WHERE id = ?').bind(expenseId).first<{ amount_minor: number }>())
      ?.amount_minor ?? null;
  const countRows = async (table: 'expenses' | 'monthly_closings', groupId: string) =>
    (await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE group_id = ?`).bind(groupId).first<{ n: number }>())!.n;
  const readToken = async (groupId: string) =>
    (await db.prepare('SELECT write_token FROM expense_groups WHERE id = ?').bind(groupId).first<{ write_token: string | null }>())!
      .write_token;

  describe('書き込めるとき', () => {
    it('バージョンが1つ上がり、tokenが書かれ、後続のSQLが実行される', async () => {
      const f = await addGroup();
      assert.equal(await readDataVersion(db, f.groupId), 0);
      assert.equal(await readToken(f.groupId), null);

      const expenseId = id('expense');
      const result = await writeToGroup(db, f.groupId, 0, (token) => [insertExpense(f, token, expenseId)]);

      assert.ok(result.ok);
      assert.equal(await readDataVersion(db, f.groupId), 1);
      assert.equal(await readToken(f.groupId), result.token);
      assert.equal(await expenseAmount(expenseId), 4280);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].meta.changes, 1);
    });

    it('INSERT・UPDATE・DELETE を1つの batch にまとめて書ける', async () => {
      const f = await addGroup();
      const keep = id('expense');
      const remove = id('expense');
      const first = await writeToGroup(db, f.groupId, 0, (token) => [
        insertExpense(f, token, keep),
        insertExpense(f, token, remove),
      ]);
      assert.ok(first.ok);

      const second = await writeToGroup(db, f.groupId, 1, (token) => [
        updateExpense(f, token, keep, 9999),
        deleteExpense(f, token, remove),
      ]);
      assert.ok(second.ok);
      assert.deepEqual(
        second.results.map((r) => r.meta.changes),
        [1, 1],
      );
      assert.equal(await expenseAmount(keep), 9999);
      assert.equal(await expenseAmount(remove), null);
      assert.equal(await readDataVersion(db, f.groupId), 2);
    });

    it('別のグループには影響しない', async () => {
      const a = await addGroup();
      const b = await addGroup();
      const result = await writeToGroup(db, a.groupId, 0, (token) => [insertExpense(a, token, id('expense'))]);
      assert.ok(result.ok);
      assert.equal(await readDataVersion(db, a.groupId), 1);
      assert.equal(await readDataVersion(db, b.groupId), 0);
      assert.equal(await readToken(b.groupId), null);
      assert.equal(await countRows('expenses', b.groupId), 0);
    });
  });

  describe('他のリクエストが先に書いたとき', () => {
    it('古いバージョンでは競合になり、後続のINSERT・UPDATE・DELETEは何も変更しない', async () => {
      const f = await addGroup();
      const existing = id('expense');
      const doomed = id('expense');
      // 先に別のリクエストが書いて、バージョンは1になっている。
      const winner = await writeToGroup(db, f.groupId, 0, (token) => [
        insertExpense(f, token, existing),
        insertExpense(f, token, doomed),
      ]);
      assert.ok(winner.ok);
      const winnerToken = await readToken(f.groupId);

      // 負ける側は、バージョン0を読んだままの書き込み。
      const newId = id('expense');
      const loser = await writeToGroup(db, f.groupId, 0, (token) => [
        insertExpense(f, token, newId),
        updateExpense(f, token, existing, 1),
        deleteExpense(f, token, doomed),
      ]);

      assert.deepEqual(loser, { ok: false, reason: 'version' });
      assert.equal(await expenseAmount(newId), null);
      assert.equal(await expenseAmount(existing), 4280);
      assert.equal(await expenseAmount(doomed), 4280);
      // バージョンもtokenも、先に書いた側のまま。
      assert.equal(await readDataVersion(db, f.groupId), 1);
      assert.equal(await readToken(f.groupId), winnerToken);
    });

    it('同じバージョンを読んだ複数のリクエストが書くと、ちょうど1つだけが成功する', async () => {
      // 5つとも、バージョン0を読んだ状態で書く。ローカルD1は batch を直列に実行するので、これは並行実行の
      // 検査ではなく、「同じバージョンからの書き込みは1つしか通らない」というロジックの検査。
      const f = await addGroup();
      const writers = 5;
      const results = await Promise.all(
        Array.from({ length: writers }, () => {
          const expenseId = id('expense');
          return writeToGroup(db, f.groupId, 0, (token) => [insertExpense(f, token, expenseId)]);
        }),
      );
      const winners = results.filter((r) => r.ok);
      assert.equal(winners.length, 1);
      assert.deepEqual(
        results.filter((r) => !r.ok),
        Array.from({ length: writers - 1 }, () => ({ ok: false, reason: 'version' })),
      );
      // 勝った側の支出だけが入っていて、負けた側の支出は入っていない。
      assert.equal(await countRows('expenses', f.groupId), 1);
      assert.equal(await readDataVersion(db, f.groupId), 1);
      assert.equal(await readToken(f.groupId), winners[0].token);
    });

    it('古いバージョンなら、一意制約に違反するはずの書き込みでも、一意制約ではなくバージョンの競合になる', async () => {
      // 後続のSQLが実行されないので、一意制約に触れない。読み直してやり直すと、そこで初めて 'unique' になる。
      const f = await addGroup();
      const first = await writeToGroup(db, f.groupId, 0, (token) => [insertClosing(f, token, id('closing'))]);
      assert.ok(first.ok);

      const stale = await writeToGroup(db, f.groupId, 0, (token) => [insertClosing(f, token, id('closing'))]);
      assert.deepEqual(stale, { ok: false, reason: 'version' });
      const reread = await writeToGroup(db, f.groupId, 1, (token) => [insertClosing(f, token, id('closing'))]);
      assert.deepEqual(reread, { ok: false, reason: 'unique' });
    });

    it('簡略化した条件（data_version = v + 1）では、負けた側の後続SQLまで実行されてしまう', async () => {
      // 8章の注意の実例。実装ではこの形にしてはいけない。
      const f = await addGroup();
      const winner = await writeToGroup(db, f.groupId, 0, (token) => [insertExpense(f, token, id('expense'))]);
      assert.ok(winner.ok);

      // 負ける側は、バージョン0を読んでいた。最初のUPDATEは0件だが、後続の条件が data_version = 0 + 1
      // なので、すでに1になっているバージョンと一致してしまう。
      const staleVersion = 0;
      const loserExpense = id('expense');
      const [bump, naive] = await db.batch([
        db
          .prepare(
            `UPDATE expense_groups SET data_version = data_version + 1, write_token = ?
              WHERE id = ? AND data_version = ?`,
          )
          .bind('naive-token', f.groupId, staleVersion),
        db
          .prepare(
            `INSERT INTO expenses (id, group_id, expense_date, target_month, amount_minor, category_id,
               payer_member_id, created_by_member_id, split_method, created_at, updated_at)
             SELECT ?, ?, '2026-11-19', '2026-11', 100, ?, ?, ?, 'category', 1, 1
              WHERE EXISTS (SELECT 1 FROM expense_groups WHERE id = ? AND data_version = ?)`,
          )
          .bind(loserExpense, f.groupId, f.categoryId, f.memberId, f.memberId, f.groupId, staleVersion + 1),
      ]);
      assert.equal(bump.meta.changes, 0, '競合の検出自体はできている');
      assert.equal(naive.meta.changes, 1, 'しかし後続のSQLは実行されてしまう');
      assert.equal(await expenseAmount(loserExpense), 100);
    });

    it('競合したら読み直して、1回だけやり直せる', async () => {
      const f = await addGroup();
      // 自分がバージョンを読んだ後に、別のリクエストが書く。
      const myVersion = await readDataVersion(db, f.groupId);
      assert.equal(myVersion, 0);
      const other = await writeToGroup(db, f.groupId, 0, (token) => [insertExpense(f, token, id('expense'))]);
      assert.ok(other.ok);

      const mine = id('expense');
      const attempt = (version: number) =>
        writeToGroup(db, f.groupId, version, (token) => [insertExpense(f, token, mine)]);
      const first = await attempt(myVersion!);
      assert.deepEqual(first, { ok: false, reason: 'version' });
      assert.equal(await expenseAmount(mine), null);

      const reread = await readDataVersion(db, f.groupId);
      assert.equal(reread, 1);
      const second = await attempt(reread!);
      assert.ok(second.ok);
      assert.equal(await expenseAmount(mine), 4280);
      assert.equal(await readDataVersion(db, f.groupId), 2);
    });
  });

  describe('バージョンを読む順序（lost update）', () => {
    // 支出の金額に1000円を足す、読み取り→書き込みの処理。間に、別のリクエストが金額を書き換える。
    const raise = async (f: Fixture, expenseId: string, order: 'version-first' | 'data-first') => {
      let version: number | null = null;
      if (order === 'version-first') version = await readDataVersion(db, f.groupId);
      const amount = await expenseAmount(expenseId);
      // ここで別のリクエストが、金額を 5000 に書き換えて確定する。
      const other = await writeToGroup(db, f.groupId, (await readDataVersion(db, f.groupId))!, (token) => [
        updateExpense(f, token, expenseId, 5000),
      ]);
      assert.ok(other.ok);
      if (order === 'data-first') version = await readDataVersion(db, f.groupId);
      return writeToGroup(db, f.groupId, version!, (token) => [updateExpense(f, token, expenseId, amount! + 1000)]);
    };

    it('バージョンを先に読めば、間に入った別の書き込みが競合として検出される', async () => {
      const f = await addGroup();
      const expenseId = id('expense');
      assert.ok((await writeToGroup(db, f.groupId, 0, (token) => [insertExpense(f, token, expenseId)])).ok);

      const result = await raise(f, expenseId, 'version-first');
      assert.deepEqual(result, { ok: false, reason: 'version' });
      assert.equal(await expenseAmount(expenseId), 5000, '別のリクエストの更新が残る');
    });

    it('データを先に読むと、古いデータからの計算が通り、別のリクエストの更新を黙って上書きする（してはいけない順序）', async () => {
      const f = await addGroup();
      const expenseId = id('expense');
      assert.ok((await writeToGroup(db, f.groupId, 0, (token) => [insertExpense(f, token, expenseId)])).ok);

      const result = await raise(f, expenseId, 'data-first');
      assert.ok(result.ok, '楽観ロックは通ってしまう');
      assert.equal(await expenseAmount(expenseId), 4280 + 1000, '5000への更新が失われている');
    });
  });

  describe('一意制約違反の判定（isUniqueViolation）', () => {
    it('D1のメッセージの前置きや、cause 側にある場合も拾い、他のエラーは拾わない', () => {
      const raw = 'UNIQUE constraint failed: monthly_closings.group_id, monthly_closings.target_month: SQLITE_CONSTRAINT';
      assert.ok(isUniqueViolation(new Error(`D1_ERROR: ${raw}`)));
      assert.ok(isUniqueViolation(new Error('D1_ERROR: batch failed', { cause: new Error(raw) })));
      assert.ok(isUniqueViolation(new Error('batch failed', { cause: raw })));
      assert.ok(!isUniqueViolation(new Error('D1_ERROR: CHECK constraint failed: amount_minor >= 1')));
      assert.ok(!isUniqueViolation(new Error('D1_ERROR: FOREIGN KEY constraint failed')));
      assert.ok(!isUniqueViolation(new Error('network lost', { cause: new Error('timeout') })));
      assert.ok(!isUniqueViolation({ message: 'UNIQUE constraint failed' }), 'Error でも文字列でもないものは拾わない');
      assert.ok(!isUniqueViolation(undefined));
    });
  });

  describe('batch の途中でエラーになるとき', () => {
    it('一意制約違反（二重締め）は、batch 全体がロールバックされ、バージョンの競合とは別の理由で返る', async () => {
      const f = await addGroup();
      const first = await writeToGroup(db, f.groupId, 0, (token) => [insertClosing(f, token, id('closing'))]);
      assert.ok(first.ok);
      const tokenAfterFirst = await readToken(f.groupId);

      // 最新のバージョンを読み直した上で、同じ月をもう一度締める。支出の登録も同じ batch に入れる。
      const extra = id('expense');
      const second = await writeToGroup(db, f.groupId, 1, (token) => [
        insertExpense(f, token, extra),
        insertClosing(f, token, id('closing')),
      ]);

      assert.deepEqual(second, { ok: false, reason: 'unique' });
      assert.equal(await countRows('monthly_closings', f.groupId), 1);
      assert.equal(await expenseAmount(extra), null, '同じ batch の他のSQLも取り消される');
      assert.equal(await readDataVersion(db, f.groupId), 1, 'バージョンも上がらない');
      assert.equal(await readToken(f.groupId), tokenAfterFirst);
    });

    it('CHECK制約違反などは競合にせず例外として投げ、batch 全体がロールバックされる', async () => {
      const f = await addGroup();
      const ok = id('expense');
      await assert.rejects(
        writeToGroup(db, f.groupId, 0, (token) => [
          insertExpense(f, token, ok),
          insertExpense(f, token, id('expense'), 0), // amount_minor は1以上
        ]),
        /CHECK constraint failed/,
      );
      assert.equal(await expenseAmount(ok), null);
      assert.equal(await readDataVersion(db, f.groupId), 0);
    });

    it('存在しないグループは、バージョンの競合として返る', async () => {
      const f = await addGroup();
      const result = await writeToGroup(db, 'no-such-group', 0, (token) => [insertExpense(f, token, id('expense'))]);
      assert.deepEqual(result, { ok: false, reason: 'version' });
      assert.equal(await countRows('expenses', f.groupId), 0);
    });
  });
});
