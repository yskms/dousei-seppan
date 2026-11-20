/// <reference types="node" />
// 複数のグループにまたがる書き込み（src/groupWrite.ts の writeToGroups）の検査。設計は docs/backend-design.md 8章。
// ローカルD1（miniflare）は batch を直列に実行するので、確かめるのはロジック（並行して走ったときの性質は、
// 本番D1での確認。13章の9）。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GROUP_WRITE_GUARD, writeToGroups } from '../src/groupWrite.ts';
import { createFixtureFactory } from './apiFixture.ts';
import { openLocalDatabase, type LocalDatabase } from './localDatabase.ts';

describe('複数のグループにまたがる書き込み（writeToGroups）', () => {
  let local: LocalDatabase;
  let db: D1Database;
  let factory: ReturnType<typeof createFixtureFactory>;

  before(async () => {
    local = await openLocalDatabase();
    db = local.db;
    factory = createFixtureFactory(db);
  });
  after(async () => {
    await local.dispose();
  });

  const newGroup = async () => (await factory.createGroup(['alice'])).groupId;
  const groupRow = (groupId: string) =>
    db
      .prepare('SELECT data_version, write_token FROM expense_groups WHERE id = ?')
      .bind(groupId)
      .first<{ data_version: number; write_token: string | null }>();
  const nameOf = async (groupId: string) =>
    (await db.prepare('SELECT name FROM expense_groups WHERE id = ?').bind(groupId).first<{ name: string }>())!.name;
  /** 各グループの名前を書き換える、条件つきの文（GROUP_WRITE_GUARD。自分のグループの token）。 */
  const rename = (groupIds: readonly string[], token: string) =>
    groupIds.map((groupId) =>
      db
        .prepare(`UPDATE expense_groups SET name = 'renamed' WHERE id = ? AND EXISTS (${GROUP_WRITE_GUARD})`)
        .bind(groupId, groupId, token),
    );

  it('全グループのバージョンが読んだとおりなら、全グループのバージョンが1ずつ上がり、同じ token が書かれ、後続の文が効く', async () => {
    const [a, b, c] = [await newGroup(), await newGroup(), await newGroup()];
    const result = await writeToGroups(
      db,
      [a, b, c].map((groupId) => ({ groupId, expectedVersion: 0 })),
      (token) => rename([a, b, c], token),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const groupId of [a, b, c]) {
      assert.deepEqual(await groupRow(groupId), { data_version: 1, write_token: result.token });
      assert.equal(await nameOf(groupId), 'renamed');
    }
    assert.equal(result.results.length, 3, 'results は、バージョンを上げる文を除いた build の結果');
  });

  it('1つでもバージョンが合わなければ、どのグループも変えない（バージョンも token も、後続の文も）', async () => {
    const [a, b] = [await newGroup(), await newGroup()];
    await db.prepare('UPDATE expense_groups SET data_version = 5 WHERE id = ?').bind(b).run(); // b だけ、読んだあとに進んだ
    const before = [await groupRow(a), await groupRow(b)];
    const result = await writeToGroups(
      db,
      [
        { groupId: a, expectedVersion: 0 },
        { groupId: b, expectedVersion: 0 },
      ],
      (token) => rename([a, b], token),
    );
    assert.deepEqual(result, { ok: false, reason: 'version' });
    assert.deepEqual([await groupRow(a), await groupRow(b)], before, 'a のバージョンも上がらない');
    assert.deepEqual([await nameOf(a), await nameOf(b)], ['ふたりの生活費', 'ふたりの生活費']);
  });

  it('グループごとに別々のUPDATEにすると、一部だけ書き込めてしまう（writeToGroups が避けていること）', async () => {
    const [a, b] = [await newGroup(), await newGroup()];
    await db.prepare('UPDATE expense_groups SET data_version = 5 WHERE id = ?').bind(b).run();
    const token = 'naive-token';
    await db.batch([
      db.prepare('UPDATE expense_groups SET data_version = data_version + 1, write_token = ? WHERE id = ? AND data_version = 0').bind(token, a),
      db.prepare('UPDATE expense_groups SET data_version = data_version + 1, write_token = ? WHERE id = ? AND data_version = 0').bind(token, b),
    ]);
    // a だけ上がった。後続の文が a の条件だけを見ていれば、a だけ書き込まれる。
    assert.deepEqual([(await groupRow(a))!.data_version, (await groupRow(b))!.data_version], [1, 5]);
  });

  it('知らないグループを含めたら、どのグループも変えない', async () => {
    const a = await newGroup();
    const result = await writeToGroups(
      db,
      [
        { groupId: a, expectedVersion: 0 },
        { groupId: 'no-such-group', expectedVersion: 0 },
      ],
      (token) => rename([a], token),
    );
    assert.deepEqual(result, { ok: false, reason: 'version' });
    assert.deepEqual(await groupRow(a), { data_version: 0, write_token: null });
  });

  it('追加の条件が満たされなければ、どのグループも変えない。満たされれば書く', async () => {
    const [a, b] = [await newGroup(), await newGroup()];
    const groups = [a, b].map((groupId) => ({ groupId, expectedVersion: 0 }));
    const denied = await writeToGroups(db, groups, (token) => rename([a, b], token), {
      sql: 'EXISTS (SELECT 1 FROM expense_groups WHERE id = ?)',
      bindings: ['no-such-group'],
    });
    assert.deepEqual(denied, { ok: false, reason: 'version' });
    assert.deepEqual([await groupRow(a), await groupRow(b)], [
      { data_version: 0, write_token: null },
      { data_version: 0, write_token: null },
    ]);
    const allowed = await writeToGroups(db, groups, (token) => rename([a, b], token), {
      sql: 'EXISTS (SELECT 1 FROM expense_groups WHERE id = ?)',
      bindings: [a],
    });
    assert.equal(allowed.ok, true);
  });

  it('グループの数に、束縛の上限（100）は効かない（30グループでも書ける）', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await newGroup());
    const result = await writeToGroups(
      db,
      ids.map((groupId) => ({ groupId, expectedVersion: 0 })),
      (token) => rename(ids, token),
    );
    assert.equal(result.ok, true);
    for (const groupId of ids) assert.equal((await groupRow(groupId))!.data_version, 1);
  });

  it('グループが空・重複していたら、書かずに投げる', async () => {
    const a = await newGroup();
    await assert.rejects(writeToGroups(db, [], () => []), /書くグループが無い/);
    await assert.rejects(
      writeToGroups(
        db,
        [
          { groupId: a, expectedVersion: 0 },
          { groupId: a, expectedVersion: 0 },
        ],
        () => [],
      ),
      /重複/,
    );
    assert.deepEqual(await groupRow(a), { data_version: 0, write_token: null });
  });
});
