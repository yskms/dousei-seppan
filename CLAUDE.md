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

- D1の書き込みは、`expense_groups.data_version` と `write_token` の楽観ロックで行う。1つのグループへの書き込みは `worker/src/groupWrite.ts` の `writeToGroup` を通す（読み直して1回やり直す操作は `writeToGroupWithRetry`。検証用の読み込みは、渡す `plan` の中だけで行う）。後続の文の条件を `data_version = v+1` に「簡略化」しない。バージョンは、検証・計算に使うデータより**先に**読む。失敗理由の扱い、複数グループにまたがる書き込みの未決事項は、docs/backend-design.md 8章・12章。
- 月の集計・精算額は `worker/src/monthState.ts` の `computeMonthFromState` だけが計算し、summary（締める前の見込み）と月締めの両方がこれを使う。別々に計算すると、締めた結果が見込みとずれる。月締めの書き込みは、D1のクエリ数が行数に比例して増えないよう `insertRowsGuarded` で複数行を1文にまとめている（Freeは1回の呼び出しにつき50クエリまで。文の数は費目×メンバーの数でゆるやかに増える。検査は `worker/test/closings.test.ts` の「D1のクエリ数」）。行ごとのINSERTに「簡略化」しない。
- 脱退済み（`left`）への遷移は `worker/src/closedMonth.ts` の `markLeftStatement` だけが行い、月締め・精算（とCron）が使う。繰越済み（`carried`）の送金は、繰越先の月を締めるまで未処理と同じに扱う。「繰越は処理済み」と見て条件を外さない（繰り越した額は翌月の締めまでどの送金にも入っておらず、`left` にすると本人が精算できない）。同じ理由で、脱退月より後の未締めの月の支出に本人が関わっているあいだも `left` にしない。脱退月が飛ばされた月のときは、脱退月より後の月が締められていれば、脱退月が締められたものとして扱う（`>=` を `=` に戻さない。docs/backend-design.md 5章の4）。
- 脱退の確定（`leaving` にし、翌月の割合のリセット・招待の取り消し・固定費の停止を行う）は `worker/src/membership.ts` の `confirmLeaveStatements` だけが行い、月締め・脱退を選ぶ操作・月初のCron（`worker/src/cron.ts`）が使う。経路ごとに書き写さない（確定の中身がずれる）。APIは、脱退月が終わったメンバーを、Cronの確定の前でも確定したものとして扱う（`access.ts` の `isLeaveEffective`）。最後の1人の脱退は、確定のときにグループごと消す（docs/backend-design.md 5章）。
- 複数のグループにまたがる書き込み（アカウント削除。`worker/src/accountDeletion.ts`）は `writeToGroups` を通す。バージョンを上げる文は、全グループで1文のまま。グループごとのUPDATEに分けると、一部のグループだけ書き込まれる。`accountDeletion.ts` が渡している追加条件（読んだあとに別のグループへ参加されたことの検出）も外さない。`expense_groups` の行を消す文は、ほかの文の最後にまとめる（docs/backend-design.md 8章）。
- 費目を作るときは、最初の未締めの月だけでなく、それより後で割合の行がある月すべてに、その月のメンバーでの均等な行を書く（`worker/src/categories.ts`）。最初の月だけに「簡略化」しない（後の月が、脱退・削除したメンバーを含む割合を引き継ぐ）。逆に、割合を直す `PUT` は、後の月の行を書き換えない（メンバーの増減で書いた行を上書きしない。`overriddenMonths` で知らせる。docs/backend-design.md 9章）。
- 固定費の自動登録（`worker/src/recurringRun.ts`）は、最初の検索の結果を書き込みに使わない。グループごとに、バージョンを読んだ**あとで**固定費・メンバー・締めた月を読み直す（古い金額や停止前の状態で支出を作らない）。`runScheduled` では、脱退の確定（固定費の停止を含む）のあとに呼ぶので、順番を逆にしない。アーカイブした費目の固定費は、`paused_at` で止めず、作るのだけを見送る（`paused_reason` に費目の理由を足さない。状態から導けて、費目を戻せば自動で作られる）。固定費は物理削除しない（支出と生成記録が参照する）。詳細は docs/backend-design.md 7章・9章。
- グループ内のデータを扱うAPIは、認証・所属・月の閲覧範囲の判定を `worker/src/access.ts` で行う。他のグループのID、メンバーでない人、脱退済みの人は、区別せず404にする（IDの存在を教えない）。
- グループの配下のテーブルには、必ず `group_id` が先頭の主キーか索引を持たせる。無いと、グループの削除や親の行の削除で、全グループの行を読む（D1は読んだ行数で課金。付録Aの冒頭）。
- 繰越は、翌月の締めでメンバーごとの差額に合算して、送金を作り直す。翌月の支出の総額・負担額には入れない（docs/plan.md 6章）。
- 金額は通貨の最小単位の整数、割合は1万分率の整数。浮動小数点で持たない。

## コマンド

- アプリ: `npm run typecheck`、`npm test`
- Worker（`worker/` で実行）: `npm run typecheck`、`npm test`（ルートの `npm test` には含まれない）
