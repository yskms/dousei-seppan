# 同棲折半

同棲カップル・夫婦などの共同生活費を記録し、カテゴリごとの負担割合で月ごとに精算するアプリ（iOS / Android）。

- 仕様の正本: [docs/plan.md](docs/plan.md)（企画メモ）
- データ・API・競合制御: [docs/backend-design.md](docs/backend-design.md)
- 画面: [docs/screens.md](docs/screens.md)

## 構成

- リポジトリのルートがExpoアプリ（Expo Router）。`app/` は画面（ルート）のディレクトリで、アプリ全体のフォルダではない。
- `worker/` は、Cloudflare Workers + D1 のバックエンド。自前の `package.json`・ロックファイル・tsconfigを持つ独立したパッケージ。
- `src/` はNodeのテスト（`npm test`）から直接実行するため、画面（RN・Expoのimport）を置かない。

## 変えてはいけないもの（Singfolioと同じ理由）

- **npm workspacesにしない。** ルートのExpo / RNの依存の固定が、hoistingで崩れうる。
- **ルートの `tsconfig.json` は `worker/` を除外したまま。** Workerは独自のtsconfig（workerdの型）で型チェックする。
- **アプリとWorkerでコードを共有しない。** リクエスト・レスポンスの形は docs を正として、両側に書く。負担・精算の計算はWorkerだけが持ち、アプリには `summary` API の結果を表示させる（ホームの精算見込みも同じ）。
- 認証はSingfolio（`~/Developer/singfolio/worker`）からのコピー。コピー元のコミットをコードコメントに書き、Singfolio側の修正は手で取り込む（docs/backend-design.md 1章）。

## 設計上の注意（docs に詳細）

- D1の書き込みは、`expense_groups.data_version` と `write_token` の楽観ロックで行う。1つのグループへの書き込みは `worker/src/groupWrite.ts` の `writeToGroup` を通し、後続の文には `GROUP_WRITE_GUARD` の条件を付ける。後続の文の条件を `data_version = v+1` に「簡略化」しない（負けた側の後続SQLまで実行される）。バージョンは、検証・計算に使うデータより**先に**読む（後に読むと別のリクエストの更新を黙って上書きする）。失敗は `'version'`（読み直してやり直せる）と `'unique'`（やり直さない）に分けて返る。複数グループにまたがる書き込み（アカウント削除）は未決（docs/backend-design.md 8章・12章）。
- グループの配下のテーブルには、必ず `group_id` が先頭の主キーか索引を持たせる。無いと、グループの削除や親の行の削除で、全グループの行を読む（D1は読んだ行数で課金。付録Aの冒頭）。
- 繰越は、翌月の締めでメンバーごとの差額に合算して、送金を作り直す。翌月の支出の総額・負担額には入れない（docs/plan.md 6章）。
- 金額は通貨の最小単位の整数、割合は1万分率の整数。浮動小数点で持たない。

## コマンド

- アプリ: `npm run typecheck`、`npm test`
- Worker（`worker/` で実行）: `npm run typecheck`、`npm test`（ルートの `npm test` には含まれない）
