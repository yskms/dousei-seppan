# 同棲折半：バックエンド設計メモ

- 更新日：2026-11-18
- 状態：設計方針まとめ／実装前レビュー用
- バックエンド候補：Cloudflare Workers + D1（SQLite）
- 仕様の正本は企画メモ（[plan.md](plan.md)）。このメモは、それをD1とWorkerでどう実現するかをまとめる。食い違ったときは企画メモに合わせる
- 認証：Singfolioの既存実装（`singfolio/worker`）を流用する。Singfolioとアカウントを共通にするかは未決（企画メモ16章）。このメモでは、アプリごとに分ける前提で書く

---

## 1. 方針

### アプリの前提

- 2人での利用を中心に、3人以上のグループにも対応する。
- 家計の共通支出を記録・集計するアプリ。旅行の異通貨割り勘アプリではない。
- 1グループにつき1通貨。グループ内で複数通貨を混在させない。通貨換算・為替レート取得は対象外。
- 月単位で集計する（1日〜末日が基本）。月は、月の途中でも締められる（途中で精算して解散したい、月末を待たずに締めたい、など）。
- 支出の日付と、どの月に登録するかは独立させる。締めた後に出た支出（入力漏れや、早めに締めた月の残り）は、登録できる月に登録する（8章）。
- 月締め後、その月の支出は追加・編集・削除できない。締めの取り消し・再オープン機能は設けない。
- 前の月の締めと、その月のすべての送金の精算または繰越が済んでいないと、次の月は締められない。
- 締めた月の送金ごとに、「精算する」か「次月に繰り越す」を選ぶ。月やグループ全体をモードで固定しない。
- 繰り越した送金は、翌月を締めるときに、メンバーごとの差額に足してから送金を作り直す（4章）。翌月の支出・負担額には加算しない。もう一度繰り越せば、さらに翌月に合算されるだけなので、「再繰越」という操作は無い。
- 費目による負担は、月の費目ごとの合計に負担割合をかけて計算する。月の途中で割合を変えたら、その月全体に反映する。締めた時点で確定する。
- 固定費はテンプレートとして登録し、毎月の支出レコードは通常の支出として作成する。
- 招待URLはワンタイム・発行から3日で失効。URLを開いただけでは参加させず、グループ名と招待元を表示して「参加する」を押した後に参加処理を行う。
- 新規メンバーが閲覧できる履歴は参加月以降。脱退は月単位（「今月で脱退する」のみ）で、脱退する月を締めた時点か、翌月1日の早いほうで確定する。
- ローカル銀行連携、レシートOCR、個人資産管理などは対象外。

### インフラ方針

- Cloudflare Workers + D1を第一候補としてプロトタイプを進める。
- SingfolioのApple / Google認証・セッション処理を流用する。コードを共通化する場合も、アプリごとのデータ領域・設定・クライアントIDは分ける。
- Honoなど、既存プロジェクトで使っていない仕組みを理由なく追加しない。
- 開発中はFree枠で検証し、公開時にWorkers Paid（月額5 USDを目安）へ移行する案。
- D1はWorkerからのみアクセスさせ、クライアントから直接アクセスさせない。
- Durable Objects、シャーディング、読み取りレプリカ等は初期段階では導入しない。
- 月初の処理（脱退の確定など）と固定費の自動登録は、Cron Triggersで行う（7章）。

---

## 2. 金額・通貨・割合

### 金額

金額は浮動小数点ではなく、通貨の最小単位を整数で保存する。

| 通貨 | 表示例 | DB保存値 | 小数桁 |
|---|---:|---:|---:|
| JPY | 1,234円 | 1234 | 0 |
| USD | $12.34 | 1234 | 2 |
| EUR | €12.34 | 1234 | 2 |
| KWD | 12.345 KWD | 12345 | 3 |

- `expense_groups.currency_code` にISO 4217の3文字コードを保存する。
- `expense_groups.currency_minor_unit` にその通貨の小数桁数を保存する。
- 通貨マスター（通貨コードと小数桁数の対応表）はアプリ側で管理する。最初のリリースから、主要通貨を選べるようにする。初期の一覧の案は JPY・USD・EUR・GBP・AUD・CAD・CNY・KRW。要望があれば追加する。
- グループ作成時の初期値はJPY。
- グループ作成後、支出が1件でも登録されたら通貨変更不可。
- 月締めにも通貨コードと小数桁数をスナップショット保存する。
- 1件の金額には上限を設け、APIで検証する（DDLにもCHECKを置く）。上限は、月の合計に負担割合（最大10000）をかけてもJavaScriptの安全整数（2^53 - 1）を超えない値にする。案：1件あたり `10^12`（JPYで1兆円）。

### 負担割合

割合は1万分率（basis points）で整数保存する。

| 表示 | DB値 |
|---:|---:|
| 100% | 10000 |
| 60% | 6000 |
| 50% | 5000 |
| 40% | 4000 |
| 33.33% | 3333 |

- 負担対象メンバー間の割合合計は10000。
- 画面上は通常のパーセント表示にする。
- 0.01%単位まで指定可能な設計。UIでそこまで細かい指定を見せるかは別途判断する。

### 金額指定

- メンバーごとの指定額合計は支出総額と完全一致必須。
- 差額の自動配分はしない。合計不一致なら登録できない。

### 端数

- 均等割り・割合割りでは、最小通貨単位で計算する。
- 各メンバーの値を切り捨てで出し、残った端数を、割合が0より大きいメンバーに固定順で1単位ずつ配分する。
- 例：10,000円を3人で均等割り → 3,334円、3,333円、3,333円。
- 1円単位の公平性を追求する機能は設けない。ただし各メンバーの負担額の合計は、元の金額と必ず一致させる（一致しないと、精算の差額の合計がゼロにならない）。
- 固定順はメンバーIDなど、端末やリクエスト順に依存しない値を使う。
- 費目による負担では「費目の月合計」に対して、個別設定の支出では「その支出の金額」に対して、この端数処理を行う。

---

## 3. 負担・精算ロジック

### 負担方法

支出ごとに `split_method` を持つ。

- `category`：費目の負担割合を使う（既定）。負担額は支出ごとには保存せず、月の集計で計算する。
- `equal`：対象メンバーで均等割り。
- `ratio`：支出ごとに指定した割合で割る。割合合計は10000。
- `fixed`：支出ごとに金額を指定。指定額合計は支出額と一致。
- `single`：1人が全額負担する。

`category` 以外は、企画メモの「この支出だけ負担割合を変える」にあたる。支払った人（payer）と負担する人は別概念として保存する。支払った人が全額負担するとは限らない。

### 保存する負担データ

- `expenses.amount_minor`：支出総額
- `category_month_settings`：月ごと・費目ごとの設定（上限額つきの負担の、負担する人と上限額）
- `category_month_shares`：月ごと・費目ごと・メンバーごとの負担割合
- `expense_allocations`：`category` 以外の支出の、メンバーごとの確定負担額（`burden_minor`）。割合指定のときは `share_basis_points` も残す

`category` の支出には `expense_allocations` を作らない。割合を変えたときに、その月の支出を計算し直す必要をなくすため。個別設定の支出は、登録時に計算した負担額を保存し、あとから計算ロジックが変わっても変化しないようにする。

### 月ごとの負担割合

- ある費目・ある月の設定は、`category_month_settings` のうち、その月以前で最も新しい月の行と、同じ月の `category_month_shares` の行の組を使う（行が無い月は、直前の月の設定を引き継ぐ）。
- `category_month_settings` の1行と `category_month_shares` の行の組は、常に同じ月でまとめて書く。どの月の設定を使うかは、`category_month_settings` の月で決まる。
- 読み取り時には行をコピーしない。次のときに、その月の行の組を書く。
  - その月の割合を変更したとき
  - 費目を作ったとき（有効なメンバーで均等）
  - メンバーが参加した月（その月の全費目を、新しいメンバーを含めた均等にリセットする）
  - 脱退が確定した月（その月の全費目を、残るメンバーでの均等にリセットする）
  - 月締め時（その月の行が無ければ、引き継いだ割合を書き、確定値として残す）
- 1つの費目・月の行は、その月に負担対象となる全メンバーの組として書き、合計を10000にする。
- 割合を変更できるのは、締めていない月だけ。
- メンバーの増減で均等にリセットするときは、上限額の設定も外す（`cap_member_id`・`cap_minor` をNULLにする）。

### 上限額つきの負担

`category_month_settings` に `cap_member_id`（負担する人）と `cap_minor`（上限額）があるとき、その費目の `category` の支出の月合計 `T` を次のように分ける。

1. 負担する人が `min(T, cap_minor)` を負担する。
2. 超えた分 `T - cap_minor`（0より大きいとき）を、`category_month_shares` の割合で全員に分ける（端数処理は2章）。負担する人の割合は、上限額を設定したときの既定値を0にする（変更できる）。

- 例：2人、外食の上限が自分の10,000円、超えた分の割合が自分0%・相手100%。`T` が8,000円なら、自分8,000円・相手0円。`T` が15,000円なら、自分10,000円・相手5,000円。
- 上限額は費目の月合計に対してかける。支出ごとの個別設定（`category` 以外）の支出は、`T` に含めない。
- 負担する人は、その月の `category_month_shares` に含まれるメンバーでなければならない（割合は0%でよい）。

### 月次集計

メンバーごとに次を集計する。

- 支払額：そのメンバーが支払った支出の合計
- 負担額：次の合計
  - 費目ごとに、`category` の支出の月合計 × その月の割合（端数処理は2章。上限額つきの費目は前節のとおり）
  - `category` 以外の支出の `expense_allocations.burden_minor`
- 差額：支払額 - 負担額
- 繰越：前の月の締めで `carried` にした送金の合計。送金先なら足し、送金元なら引く（4章）
- 精算する額：差額 + 繰越

精算する額がプラスなら受取側、マイナスなら支払側、ゼロなら精算不要。全員の差額の合計も、繰越の合計も、必ずゼロになる。

支出の総額・負担額・差額は、その月の支出だけから出す。繰越は精算する額にだけ入れる。

### 精算先の組み合わせ

「精算する額」をもとに、支払側と受取側をそれぞれ固定順で並べ、先頭同士から少ない方の残額を精算額として組み合わせる。残額がゼロになった側を次のメンバーに進める。全員の残額がゼロになるまで繰り返す。

- 繰越を足した後の額から作り直すため、繰り越した送金の組み合わせ（誰から誰へ）は、翌月には残らないことがある。たとえば「A → B」の繰越が、新しいメンバーCを経由して「A → C」「C → B」になることもある。各メンバーが払う・受け取る合計額は正しいので、これでよいとする。

- 3人以上でも同じアルゴリズムを使う。送金は最大で「差額がゼロでないメンバー数 - 1」件になる。件数が最少になることまでは保証しない（企画メモの「件数が少なくなるように」は、この意味とする）。
- 精算結果は `settlement_transfers` に保存し、後から再計算して過去の送金先・金額が変わらないようにする。

---

## 4. 月締め・精算・繰越

### 月締めの条件

Workerで次をすべて確認してから締める。

- 対象月が、カレンダー上の今月以前（グループのタイムゾーン）。月の途中でも締められるが、まだ始まっていない月は締められない。
- 対象月がまだ締められていない。
- 前の月が締め済みで、その送金がすべて `settled` または `carried`。グループで最初の月（最初の支出がある月、または作成月）はこの条件を問わない。
- 操作者が、その月に有効なメンバー。

### 月締めの処理

1. 対象月の支出・個別負担額・費目の割合と、前の月の締めの `carried` の送金を取得
2. メンバーごとの支払額・負担額・差額・繰越・精算する額を計算
3. 送金元・送金先・金額の組み合わせを計算
4. 1回の `batch()` で次を書く（8章の競合制御つき）
   - 行が無い費目の `category_month_settings`・`category_month_shares`（引き継いだ設定を書き、確定値として残す）
   - `monthly_closings`
   - `closing_member_summaries`
   - `closing_category_burdens`（費目ごとの合計と、メンバーごとの負担額。履歴画面の内訳用）
   - `settlement_transfers`

月締め後は、API側で対象月への支出の追加・編集・削除と、割合の変更を拒否する。UIだけで制限しない。

送金が0件の月（全員の差額がゼロ）は、締めた時点で処理済みとなる。

### 精算と繰越

送金ごとに状態を持つ。

- `pending`：未処理
- `settled`：精算済み
- `carried`：次月に繰越済み

- 許可する状態遷移は `pending → settled` と `pending → carried` だけ。どちらも、確定後に戻せない。
- 脱退を選んだメンバー（`leave_requested_month` あり）、`leaving`、`deleted` のメンバー（5章）が送金元・送金先のどちらかである送金は、`carried` にできず、`settled` にするしかない。削除されたユーザーとの送金も、金額と方向は表示されているので、残るメンバーが確認して精算済みにする。
- 月は、すべての送金が `settled` または `carried` になった時点で処理済みとなる。処理済みかどうかは送金の状態から判定し、別に保存しない。

### 繰越

- 繰越先は常に、締めた月の翌月。翌月を締めるとき、前の月の締めの `carried` の送金を、メンバーごとの繰越として精算する額に足す（3章）。
- 繰越の元は、元の送金レコード（`status = 'carried'`）。締める前の見込みの計算でも、同じレコードから足す。締めた結果は `closing_member_summaries.carried_in_minor` に残す。
- 前の月の送金がすべて処理済みでないと翌月は締められないため、翌月を締める時点で繰越の額は確定している。
- 繰越を何度選んでも、毎月「前の月の締めの `carried`」だけを足すので、同じ金額を二重に数えない（2か月前の繰越は、前の月の送金にすでに入っている）。
- 繰越分は、翌月の支出の総額・負担額には含めない。
- 繰越を含むことは、繰越先の月を閲覧できる全メンバー（その月に参加した新メンバーを含む）に見せる。

---

## 5. メンバーの参加・脱退・匿名化

### メンバーの状態

| `status` | 意味 |
|---|---|
| `active` | 参加中。`leave_requested_month` が入っていれば「今月で脱退する」を選んだ状態で、脱退が確定するまで取り消せる |
| `leaving` | 脱退が確定した（脱退月を締めた、または翌月1日を過ぎた）が、関わる送金が未処理のため、メンバーとして残っている |
| `left` | 脱退済み。名前は残す。グループのデータは見られない |
| `deleted` | アカウント削除済み。名前は匿名化する。削除した月までは、「削除されたユーザー」として集計に含める |

### 参加

- 招待URLを開いただけでは参加しない。招待内容の確認もログイン後に行う。
- 招待情報としてグループ名・招待元を表示する。
- ユーザーが「参加する」を押した時点で、トークン・期限・未使用・未取消を検証して参加処理する。
- 招待トークンは平文で保存せず、ハッシュを保存する。招待はワンタイム、期限は3日。
- 参加処理はグループへの書き込みとして `data_version` を上げる（8章）。同じ招待で同時に参加しようとしても、片方は409になる。
- 新規メンバーの `history_from_month` は参加月とする。
- 参加月の全費目の割合を、新しいメンバーを含めた均等にリセットし、見直しのアラートを出す。
- `category` 以外の負担方法の固定費は、自動登録を止め（`paused_reason = 'member_changed'`）、アラートを出す。
- 一度脱退した人（`left`）が再参加する場合は、元のメンバー行を `active` に戻す。`history_from_month` は復帰した月にし、`leave_requested_month`・`expense_end_month`・`left_at` を消す。

### 招待の取り消し

- 発行した人は、未使用の招待をいつでも取り消せる（`revoked_at`）。
- 発行した人の脱退が確定したとき、またはアカウントを削除したときは、その人が発行した未使用の招待をすべて取り消す。
- `leaving` 以降のメンバーは招待を発行できない。

### 脱退

1. 「今月で脱退する」：`leave_requested_month` にカレンダー上の今月（脱退月）を入れる。確定するまでは取り消せる（値を消す）。最後の1人の場合は、グループのデータが完全に削除され元に戻せないことを確認ダイアログで示す。
2. 脱退の確定：脱退月を締めたとき（締めのbatchの中で）、または翌月1日（月初のCron、7章）の早いほう。脱退を選んだ時点で脱退月がすでに締められていれば（早めに締めた後）、その場で確定する。確定時に行うこと：
   - `expense_end_month` に脱退月を入れ、`status` を `leaving` にする。翌月以降の支出の支払者・負担者にできない。
   - 残るメンバーで、翌月の全費目の割合を均等にリセットし、アラートを出す。
   - 発行した未使用の招待を取り消す。
   - 脱退者が支払者の固定費のうち、付け替えられていないものは自動登録を止める（`paused_reason = 'payer_left'`）。付け替えのアラートは、脱退を選んだ時点から出す。
   - `category` 以外の負担方法の固定費は、自動登録を止める（`paused_reason = 'member_changed'`）。
   - 最後の1人だった場合は、グループを削除する（後述）。
3. `leaving` の間も、集計・締め・精算には通常どおり参加し、グループのデータを見られる。
4. 脱退月が締められ、その人が関わる送金がすべて `settled` になったら `left` にする（送金が0件なら、締めた時点で `left`）。この遷移は、締めと精算の処理の中で行う。

月の途中で抜けたいときは、脱退を選んでから、その月をすぐに締めて精算すればよい。その月の残りの支出は翌月分として登録し、翌月の通常の支出とあわせて、残るメンバーの新しい割合（均等リセット後）で計算する。

- 他のメンバーを外す機能は設けない。
- 過去の支出・負担・精算履歴は削除しない。脱退後のメンバー行は履歴・精算参照のため残し、名前もそのまま表示する（「脱退済み」と併記）。
- 2人グループで1人が脱退した場合は、残った1人のグループとして存続する。

### グループの削除

最後の1人が脱退したとき、またはアカウントを削除したときに、そのグループのデータをすべて物理削除する。外部キーに `ON DELETE CASCADE` を付けていないため、1回の `batch()` で子から順に消す。

`settlement_transfers` → `closing_category_burdens` → `closing_member_summaries` → `monthly_closings` → `expense_allocations` → `expenses` → `recurring_expense_runs` → `recurring_expense_allocations` → `recurring_expenses` → `category_month_shares` → `category_month_settings` → `categories` → `invites` → `group_members` → `expense_groups`

### アカウント削除

- 認証はSingfolioの `POST /auth/delete` に揃える。セッションに加えて再認証を求め、その場で得たAppleの認可コードでrevokeする。リフレッシュトークンはD1に保存しない。
- 月単位の脱退の規則によらず、すべてのグループからすぐに抜ける。1回の `batch()` で次を行う。
  - 自分が最後の1人のグループを削除する（上記）。
  - 残りのグループで、自分のメンバー行（過去に脱退したものを含む）を `status = 'deleted'`、`display_name = '削除されたユーザー'`、`user_id = NULL` にする。参加中だったグループでは、`expense_end_month` をカレンダー上の今月にし、翌月の全費目の割合を残るメンバーでの均等にリセットする。
  - 削除した月までの、締めていない月の集計には、「削除されたユーザー」として含めたまま計算する（費目の割合・個別負担はそのまま）。削除後に登録する支出の支払者・個別負担の対象には選べない。費目の割合から外したいときは、残るメンバーが0%にする。
  - `closing_member_summaries.display_name_snapshot` も同じ表現に匿名化する。
  - 自分が発行した未使用の招待を取り消す。
  - 自分が支払者の固定費は自動登録を止め（`paused_reason = 'payer_left'`）、付け替えのアラートを出す。
  - 関わるグループすべての `data_version` を上げる。
  - 最後に `users` の行を消す。`identities`・`sessions` は `ON DELETE CASCADE` で消える。
- 匿名化は外部キーの `ON DELETE SET NULL` に任せず、Workerが `users` を消す前に明示的に行う。`group_members.user_id` の `ON DELETE SET NULL` は、消し漏れに対する保険。
- 金額・支出・精算履歴は残す。支出の内容（自由入力）も消さない。グループで共有している記録で、他のメンバーが代わりに入力したものも混ざるため。名前は匿名化し、内容は残すことをプライバシーポリシーに書く。

**注意：** 脱退とアカウント削除は同じ操作ではない。脱退はグループ単位で月単位、アカウント削除は全グループにすぐ及び、本人情報も消す。

---

## 6. D1テーブル一覧

### 認証（Singfolioと同じ構成）

| テーブル | 役割 |
|---|---|
| `users` | アプリ内ユーザー。本人を特定する情報は持たない |
| `identities` | Apple / Googleの `sub`。email・名前などのクレームは保存しない |
| `sessions` | セッション値のハッシュ |
| `used_nonces` | 使用済みnonce（リプレイ防止） |

### グループ・メンバー

| テーブル | 役割 |
|---|---|
| `expense_groups` | グループ、通貨、タイムゾーン、競合制御用のバージョン |
| `group_members` | グループ内メンバー、状態、表示名、履歴閲覧範囲、脱退 |
| `invites` | 招待トークンのハッシュ、有効期限、使用・取消状態 |

### 支出・負担

| テーブル | 役割 |
|---|---|
| `categories` | グループごとの費目。削除せずアーカイブ |
| `category_month_settings` | 月ごとの費目別の設定（上限額つきの負担） |
| `category_month_shares` | 月ごとの費目別・メンバー別負担割合 |
| `expenses` | 支出本体 |
| `expense_allocations` | `category` 以外の支出の、メンバー別確定負担額 |
| `recurring_expenses` | 固定費テンプレート |
| `recurring_expense_allocations` | 固定費テンプレートの個別負担設定 |
| `recurring_expense_runs` | 固定費を、どの月に作ったか（作らなかったか）の記録 |

### 月締め・精算

| テーブル | 役割 |
|---|---|
| `monthly_closings` | グループ・対象月の締め記録。グループと月の組み合わせは一意 |
| `closing_member_summaries` | 締め時点のメンバー別支払額・負担額・差額・表示名スナップショット |
| `closing_category_burdens` | 締め時点の費目別合計とメンバー別負担額 |
| `settlement_transfers` | 送金元・送金先・金額・精算状態（繰越もここで表す） |

### DB制約とWorker検証の分担

DBで保証するもの：

- 主キー・外部キー
- 同じグループ内の関連付け（複合外部キー）
- 金額が負数にならないこと、上限を超えないこと
- 割合が0〜10000の範囲であること
- 月・日付の書式（`YYYY-MM`、`YYYY-MM-DD`）
- 送金の状態と、精算・繰越日時の整合
- 1グループ・1か月につき締めは1件だけ
- 1支出・1メンバーにつき負担レコードは1件だけ
- 1つの固定費テンプレート・対象月につき生成記録は1件だけ

Workerで保証するもの：

- 負担割合の合計が10000
- 金額指定の合計・負担額の合計が支出額と一致
- メンバーが対象月に有効であること
- 対象月が締め済みでないこと、締めの条件（4章）
- 送金の状態遷移と、脱退者の送金を繰り越さないこと
- グループ通貨が支出登録後に変更されないこと
- 操作ユーザーが対象グループの権限を持つこと
- 参加月より前の履歴を閲覧できないこと

SQLiteの `CHECK` 制約だけでは複数行の合計や他テーブルの状態を保証できないため、Workerの検証と、8章の競合制御で扱う。

---

## 7. 定期処理（Cron Triggers）

- Cronは1時間ごとに動かし、各グループの `timezone` で日付を判定する。処理はすべて冪等にする（同じ時刻に2回動いても結果が変わらない）。
- 月初の処理：脱退月が締められていない脱退の確定（5章）。
- 固定費の自動登録：
  - 対象：`start_month` 以降、`end_month` 以前（または未設定）、`paused_at` が無いテンプレート。
  - 予定の月（`scheduled_month`）の `day_of_month` に達したら、支出を作る。`day_of_month` がその月の日数より大きい（31日指定の4月、29〜31日指定の2月など）ときは、月末日に作る。支出の日付も月末日にする。
  - 登録先の月（`target_month`）は、予定の月が未締めならその月。早めに締められていれば、最も古い未締めの月（通常は翌月）。日付は予定日のまま。この場合、翌月には翌月分の支出も作られ、2件になる。
  - 作るときは `recurring_expense_runs` に `(recurring_expense_id, scheduled_month)` を入れる。主キーの一意制約で二重作成を防ぐ。作った支出をユーザーが消しても記録は残るので、作り直さない。
  - 支出の作成は、通常の支出登録と同じく `data_version` を上げる（8章）。
- テンプレートの変更は、まだ作っていない月の分から反映する。作成済みの支出は変更しない（当月分だけ直したいときは、作られた支出を編集する）。

---

## 8. 同時操作・トランザクション

D1には対話的トランザクションがなく、`batch()` 単位でのみアトミック。`batch()` は直列に実行され、途中のSQLエラーで全体がロールバックされる。ただし、UPDATEやINSERT ... SELECTの対象が0件だっただけでは失敗しない。

### `expense_groups.data_version` と `write_token`

グループ内のデータへの書き込み（支出・割合・費目・固定費・締め・精算・繰越・参加・脱退・招待の発行と取り消し・グループ設定）は、すべて同じ方式で競合を検出する。

1. Workerが現在の `data_version`（`v`）を読み、検証と計算を行う。
2. リクエストごとに一意な `write_token`（UUID）を作る。
3. batchの最初のSQLで、バージョンを上げ、tokenを書く。

   ```sql
   UPDATE expense_groups SET data_version = data_version + 1, write_token = ?token
    WHERE id = ?group AND data_version = ?v;
   ```

4. 後続のSQLは、すべて「`expense_groups.write_token` がこのリクエストのtokenと一致する」ことを条件にする。INSERTは `INSERT ... SELECT ... WHERE EXISTS (...)` の形、UPDATE・DELETEは `AND EXISTS (...)` を付ける。

   ```sql
   INSERT INTO expenses (...)
   SELECT ?, ?, ...
    WHERE EXISTS (SELECT 1 FROM expense_groups WHERE id = ?group AND write_token = ?token);
   ```

5. 最初のUPDATEの `meta.changes` が0なら、他のリクエストが先に書き込んでいる。このとき後続のSQLも条件を満たさず、何も変更されていない。

**注意：** 後続の条件を「`data_version = v + 1`」にしてはいけない。同じ `v` を読んだ別のリクエストが先に確定すると、バージョンは `v + 1` になっているため、0件だったはずの後続SQLが実行されてしまう。

### 競合したとき

- 支出の登録・編集・削除、割合の変更など：Worker内で読み直して、1回だけやり直す。それでも競合したら409。
- 月締め・精算・繰越・参加・脱退：やり直さず409を返し、アプリに最新の状態を読み直してもらう（確認ダイアログの内容が変わりうるため）。
- 一意制約違反（二重締めなど）もbatch全体のロールバックになるので、409として扱う。

### 支出の対象月

- 支出は、登録する月（`target_month`）と日付（`expense_date`）を別に持ち、両者の関係は制限しない。入力漏れの書き方は利用者に任せる（内容に「先月分の○○」と書く、日付を月初にする、実際の日付のままにする、など）。
- 登録できる月は、未締めの月のうちカレンダー上の今月以前のもの。今月がすでに締められていれば、翌月。締めは古い月から順に行うので、未締めの月は連続している。通常は「今月（と、未締めなら前月）」、今月を早めに締めた後は「翌月」だけになる。
- アプリは、表示中の月を登録先にする。日付の既定値は今日。
- `target_month` が登録できる月であることは、Workerが読んだ時点で確認する。月締めもバージョンを上げるので、確認後に締められた場合は競合として検出される。

---

## 9. APIのたたき台

URLやHTTPメソッドは実装時に調整してよい。以下は責務の整理。

### 認証（Singfolioに揃える）

| API | 役割 |
|---|---|
| `POST /auth/nonce` | nonceの発行 |
| `POST /auth/login` | Apple（iOS）・Googleのログイン |
| `GET /auth/apple/callback`、`POST /auth/apple/login` | AndroidでのAppleログイン（Web経由） |
| `POST /auth/apple/notifications` | Appleのサーバー間通知 |
| `POST /auth/logout` | ログアウト |
| `POST /auth/delete` | アカウント削除（再認証つき） |

Webからのアカウント削除依頼（Google Play向け）の本人確認は未決（企画メモ16章）。Singfolioの、Web経由のAppleログインと同じ手順を流用する案。

### グループ・メンバー・招待

| API | 役割 |
|---|---|
| `POST /groups` | グループ作成 |
| `GET /groups` | 所属グループ一覧 |
| `GET /groups/:id` | グループ情報 |
| `PATCH /groups/:id` | グループ名等の変更 |
| `POST /groups/:id/invites` | 招待URL発行 |
| `DELETE /invites/:id` | 招待の取り消し（発行した人のみ） |
| `GET /invites/:token` | 招待内容確認（要ログイン）。参加はしない |
| `POST /invites/:token/join` | 明示的な参加 |
| `POST /groups/:id/leave` | 「今月で脱退する」 |
| `DELETE /groups/:id/leave` | 脱退の取り消し（当月中のみ） |

### 費目・負担割合・支出・固定費

| API | 役割 |
|---|---|
| `GET /groups/:id/categories` | 費目一覧 |
| `POST /groups/:id/categories` | 費目作成 |
| `PATCH /categories/:id` | 費目変更・アーカイブ |
| `GET /groups/:id/months/:month/category-shares` | その月の費目別負担割合 |
| `PUT /groups/:id/months/:month/category-shares/:categoryId` | その月の負担割合の変更 |
| `GET /groups/:id/expenses` | 支出一覧 |
| `POST /groups/:id/expenses` | 支出登録 |
| `PATCH /expenses/:id` | 支出編集 |
| `DELETE /expenses/:id` | 支出削除 |
| `GET /groups/:id/recurring-expenses` | 固定費一覧 |
| `POST /groups/:id/recurring-expenses` | 固定費登録 |
| `PATCH /recurring-expenses/:id` | 固定費変更・停止・再開 |

### 月締め・精算

| API | 役割 |
|---|---|
| `GET /groups/:id/months/:month/summary` | 月次集計（前月からの繰越を足した精算の見込みを含む） |
| `POST /groups/:id/months/:month/close` | 月締め |
| `GET /groups/:id/months/:month/closing` | 締め結果 |
| `POST /transfers/:id/settle` | 精算済みにする |
| `POST /transfers/:id/carry` | 次月に繰り越す |

全APIで、認証・グループ所属・対象データのグループ一致・月の閲覧範囲・締め状態をWorker側で検証する。IDを知っているだけで他グループのデータにアクセスできないようにする。これらの判定は共通の関数にまとめる。Premiumの閲覧期間の制限（企画メモ10章）を導入するときも、同じ関数に足す。

---

## 10. マイグレーションの分割案

最初から巨大なSQLを1本にせず、変更のまとまりごとに分ける。外部キーの参照先を先に作る。

| ファイル例 | 内容 |
|---|---|
| `0001_auth.sql` | users / identities / sessions / used_nonces（Singfolioと同じ） |
| `0002_groups_members.sql` | expense_groups / group_members / invites |
| `0003_categories.sql` | categories / category_month_settings / category_month_shares |
| `0004_recurring_expenses.sql` | recurring_expenses / recurring_expense_allocations |
| `0005_expenses.sql` | expenses / expense_allocations / recurring_expense_runs |
| `0006_closings_settlements.sql` | monthly_closings / closing_member_summaries / closing_category_burdens / settlement_transfers |

D1のローカル環境で、全マイグレーションを最初から適用できることを確認する。

---

## 11. 必須テスト

### 金額・負担計算

- JPY・USD・小数桁3の通貨での金額保存と表示
- 2人・3人以上の均等割り
- 割合合計10000の正常ケース、10000でないケースの拒否
- 金額指定の合計一致・不一致
- 端数が出る場合の固定順配分（割合0%のメンバーには配らない）
- 支払者と負担者が異なるケース
- 費目の月合計 × 割合で計算されること（企画メモ5章の精算例が、相手から自分へ17,000円になる）
- 上限額つきの負担：月合計が上限以下・ちょうど上限・上限超えの3通り。超えた分の割合を、負担する人0%・0%以外の両方で
- 月の途中で割合を変えると、その月の `category` の支出すべてに反映されること
- 個別設定の支出が、費目の合計から除外されること
- 割合の行が無い月が、直前の月の割合を引き継ぐこと
- 全員の差額の合計がゼロになること

### 月締め

- 通常の月締め
- 月の途中での締め、まだ始まっていない月の締めの拒否
- 前の月が未締め、または未処理の送金がある状態での締めの拒否
- 同じ月の二重締め
- 締め後の支出追加・編集・削除、割合変更の拒否
- 月締め中に支出登録・割合変更が競合（同じ `data_version` を読んだ2リクエストで、片方の後続SQLが実行されないこと）
- 3人以上の精算組み合わせ
- 精算済み・繰越・未処理の混在
- `settled`・`carried` から別の状態への変更の拒否
- 脱退予定・脱退処理中のメンバーが関わる送金の繰越の拒否
- 繰越が、翌月の支出の総額・負担額には加算されず、翌月の締めの精算する額に加算されること
- 2か月続けて繰り越したときに、金額を二重に数えないこと
- 3人で繰越がある月の送金の合計が、メンバーごとの精算する額と一致すること
- 早めに締めた後、同じ暦月の日付の支出を翌月分として登録できること
- 登録できる月以外（締め済みの月、2か月以上先の月）への登録の拒否

### メンバー・権限

- 招待URLを開いただけでは参加しない
- 期限切れ・使用済み・取消済み招待の拒否
- 同じ招待での同時参加で、1人だけ参加できること
- 発行者の脱退確定・アカウント削除で、未使用の招待が取り消されること
- 参加月の割合が均等にリセットされ、上限額の設定が外れること、個別負担の固定費が止まること
- 異なるグループのIDを指定した操作の拒否
- 参加月より前の履歴閲覧拒否
- 脱退の取り消し（当月中）と、翌月以降の取り消しの拒否
- 脱退確定後、送金がすべて精算されるまで `leaving` のままであること
- 脱退後も過去の精算参照が壊れないこと、名前が残ること
- 再参加で元のメンバー行に戻り、履歴が復帰月以降になること
- 脱退月を早めに締めた時点で脱退が確定し、取り消せなくなること
- 早めに締めた後に脱退を選ぶと、その場で確定すること
- 最後の1人の脱退でグループのデータがすべて消えること
- アカウント削除時の名前匿名化（過去に脱退したグループを含む）
- 削除したユーザーが、削除した月までの集計に含まれ、翌月の割合から外れること
- 削除したユーザーが関わる送金を繰り越せず、精算済みにはできること
- アカウント削除後に認証情報から本人を再特定できないこと

### 固定費

- 同じ月に同じ固定費が二重生成されないこと
- 生成された支出を消しても、同じ月に作り直されないこと
- 生成済み支出がテンプレート変更で変化しないこと
- 31日指定など、月末に存在しない日付の扱い
- 停止中・終了後のテンプレートから新しい支出が生成されないこと
- 予定の月が早めに締められていたら、最も古い未締めの月に登録されること

---

## 12. 実装前に残る確認事項

（いまは無し。以前の確認事項は、固定費の月末日を7章、匿名化の範囲を5章、対応通貨を2章で決めた）

---

## 13. 次の実装順

1. 付録AのDDLをレビューし、カラム・外部キー・削除時の挙動を確定する。
2. マイグレーションを作成し、ローカルD1へ適用する。
3. 負担額・精算額の計算関数を、DB非依存のTypeScriptとして実装・テストする。
4. 8章の競合制御を、ローカルD1で小さく検証する。
5. 支出CRUD APIを実装する。
6. 月締め・精算・繰越APIを実装する。
7. 招待・参加・脱退・匿名化APIと、Cronの処理を実装する。
8. 競合・権限・二重登録の統合テストを実施する。
9. Workers FreeでCPU時間・D1クエリ数を確認し、公開前にPaidへ移行するか判断する。

**この文書は設計方針のまとめであり、SQLはまだ本番投入用の確定版ではない。** 次工程では、実際のマイグレーションを作りながらSQLite/D1で制約とトランザクションを検証する。

---

# 付録A：D1用SQL DDL 初版

> 注意：以下は設計を具体化するための初版DDL。まだ本番適用済み・実機検証済みではない。D1ローカル環境でマイグレーション適用、外部キー、トランザクション、削除・匿名化の挙動を確認してから採用する。実際のmigrationファイルはこの付録から分割して作成する。

共通の約束（Singfolioに揃える）：

- テーブルは `STRICT, WITHOUT ROWID`。IDはTEXT（UUID）。
- 日時はUnixエポックのミリ秒（INTEGER）。月は `YYYY-MM`、日付は `YYYY-MM-DD` のTEXT。
- D1は外部キーを既定で強制するので、`PRAGMA foreign_keys` は書かない。
- 金額の上限 `1000000000000`（2章）は、実装時に定数として1か所にまとめる。

## A-1. 認証

Singfolioの `worker/migrations/0001`〜`0003` と同じ構成にする（`users`、`identities`、`sessions`、`used_nonces`）。要点のみ示す。

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google')),
  sub TEXT NOT NULL CHECK (sub <> ''),
  created_at INTEGER NOT NULL,
  last_sign_in_at INTEGER NOT NULL,
  consent_revoked_at INTEGER,
  UNIQUE (provider, sub)
) STRICT, WITHOUT ROWID;

-- sessions / used_nonces はSingfolioと同じ。
```

## A-2. グループ・メンバー・招待

```sql
CREATE TABLE expense_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (name <> ''),
  currency_code TEXT NOT NULL CHECK (length(currency_code) = 3 AND currency_code = upper(currency_code)),
  currency_minor_unit INTEGER NOT NULL CHECK (currency_minor_unit BETWEEN 0 AND 3),
  timezone TEXT NOT NULL,
  data_version INTEGER NOT NULL DEFAULT 0 CHECK (data_version >= 0),
  write_token TEXT,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE group_members (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  -- アカウント削除時はWorkerが匿名化とあわせてNULLにする。SET NULLは消し漏れへの保険。
  user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'leaving', 'left', 'deleted')),
  history_from_month TEXT NOT NULL CHECK (history_from_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  leave_requested_month TEXT CHECK (leave_requested_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  expense_end_month TEXT CHECK (expense_end_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  CHECK (status <> 'deleted' OR user_id IS NULL),
  CHECK (status NOT IN ('leaving', 'left') OR expense_end_month IS NOT NULL),
  UNIQUE (id, group_id),
  UNIQUE (group_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_group_members_user ON group_members (user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  invited_by_member_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_member_id TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (invited_by_member_id, group_id) REFERENCES group_members (id, group_id),
  FOREIGN KEY (consumed_by_member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK ((consumed_at IS NULL) = (consumed_by_member_id IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_invites_group ON invites (group_id);
```

## A-3. 費目・負担割合

```sql
CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  name TEXT NOT NULL CHECK (name <> ''),
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_categories_group ON categories (group_id);

-- 行が無い月は、その月以前で最も新しい月の行と、同じ月の category_month_shares の組を使う（3章）。
-- 上限額つきの負担を使わない月も、行は書く（どの月の設定を使うかを、この表の月で決めるため）。
CREATE TABLE category_month_settings (
  group_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  cap_member_id TEXT,
  cap_minor INTEGER CHECK (cap_minor BETWEEN 1 AND 1000000000000),
  PRIMARY KEY (category_id, target_month),
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (cap_member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK ((cap_member_id IS NULL) = (cap_minor IS NULL))
) STRICT, WITHOUT ROWID;

-- 超えた分の割合（上限額つきでなければ、月合計の割合）。category_month_settings と同じ月でまとめて書く。
CREATE TABLE category_month_shares (
  group_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  member_id TEXT NOT NULL,
  share_basis_points INTEGER NOT NULL CHECK (share_basis_points BETWEEN 0 AND 10000),
  PRIMARY KEY (category_id, target_month, member_id),
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id)
) STRICT, WITHOUT ROWID;
```

## A-4. 固定費

```sql
CREATE TABLE recurring_expenses (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  description TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  category_id TEXT NOT NULL,
  payer_member_id TEXT NOT NULL,
  split_method TEXT NOT NULL CHECK (split_method IN ('category', 'equal', 'ratio', 'fixed', 'single')),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  start_month TEXT NOT NULL CHECK (start_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  -- 終了した月。NULLなら終了日なし。テンプレートは物理削除しない。
  end_month TEXT CHECK (end_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  paused_at INTEGER,
  paused_reason TEXT CHECK (paused_reason IN ('member_changed', 'payer_left', 'manual')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (payer_member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK ((paused_at IS NULL) = (paused_reason IS NULL)),
  CHECK (end_month IS NULL OR end_month >= start_month),
  UNIQUE (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_recurring_expenses_group ON recurring_expenses (group_id);

-- split_method が 'category' 以外のときの個別負担設定。
-- equal・single は対象メンバーの行だけを持ち、割合・金額はNULL。
CREATE TABLE recurring_expense_allocations (
  group_id TEXT NOT NULL,
  recurring_expense_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  share_basis_points INTEGER,
  amount_minor INTEGER,
  PRIMARY KEY (recurring_expense_id, member_id),
  FOREIGN KEY (recurring_expense_id, group_id) REFERENCES recurring_expenses (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK (
    (share_basis_points IS NOT NULL AND amount_minor IS NULL AND share_basis_points BETWEEN 0 AND 10000)
    OR (share_basis_points IS NULL AND amount_minor IS NOT NULL AND amount_minor BETWEEN 0 AND 1000000000000)
    OR (share_basis_points IS NULL AND amount_minor IS NULL)
  )
) STRICT, WITHOUT ROWID;
```

## A-5. 支出・負担額

```sql
CREATE TABLE expenses (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  expense_date TEXT NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  description TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  category_id TEXT NOT NULL,
  payer_member_id TEXT NOT NULL,
  created_by_member_id TEXT NOT NULL,
  split_method TEXT NOT NULL CHECK (split_method IN ('category', 'equal', 'ratio', 'fixed', 'single')),
  recurring_expense_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (payer_member_id, group_id) REFERENCES group_members (id, group_id),
  FOREIGN KEY (created_by_member_id, group_id) REFERENCES group_members (id, group_id),
  -- recurring_expense_id がNULLなら、SQLiteは複合外部キーを検査しない。
  FOREIGN KEY (recurring_expense_id, group_id) REFERENCES recurring_expenses (id, group_id),
  -- target_month と expense_date の関係は制限しない（8章）。
  UNIQUE (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_expenses_group_month ON expenses (group_id, target_month, expense_date);

-- split_method が 'category' の支出には行を作らない（3章）。
CREATE TABLE expense_allocations (
  group_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  burden_minor INTEGER NOT NULL CHECK (burden_minor BETWEEN 0 AND 1000000000000),
  share_basis_points INTEGER CHECK (share_basis_points IS NULL OR share_basis_points BETWEEN 0 AND 10000),
  PRIMARY KEY (expense_id, member_id),
  FOREIGN KEY (expense_id, group_id) REFERENCES expenses (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id)
) STRICT, WITHOUT ROWID;

-- 固定費をどの月に作ったか。作った支出が消されても行は残し、作り直さない（7章）。
-- expense_id は、支出が消されうるため外部キーにしない。
CREATE TABLE recurring_expense_runs (
  group_id TEXT NOT NULL,
  recurring_expense_id TEXT NOT NULL,
  -- 予定の月。作った支出の target_month は、早めに締められていれば翌月以降になりうる（7章）。
  scheduled_month TEXT NOT NULL CHECK (scheduled_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  expense_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (recurring_expense_id, scheduled_month),
  FOREIGN KEY (recurring_expense_id, group_id) REFERENCES recurring_expenses (id, group_id)
) STRICT, WITHOUT ROWID;
```

## A-6. 月締め・精算

```sql
CREATE TABLE monthly_closings (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES expense_groups (id),
  target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  currency_code TEXT NOT NULL,
  currency_minor_unit INTEGER NOT NULL,
  data_version INTEGER NOT NULL,
  closed_by_member_id TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  FOREIGN KEY (closed_by_member_id, group_id) REFERENCES group_members (id, group_id),
  UNIQUE (id, group_id),
  UNIQUE (group_id, target_month)
) STRICT, WITHOUT ROWID;

CREATE TABLE closing_member_summaries (
  group_id TEXT NOT NULL,
  closing_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  paid_minor INTEGER NOT NULL CHECK (paid_minor >= 0),
  burden_minor INTEGER NOT NULL CHECK (burden_minor >= 0),
  difference_minor INTEGER NOT NULL,
  carried_in_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL,
  PRIMARY KEY (closing_id, member_id),
  FOREIGN KEY (closing_id, group_id) REFERENCES monthly_closings (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK (difference_minor = paid_minor - burden_minor),
  CHECK (net_minor = difference_minor + carried_in_minor)
) STRICT, WITHOUT ROWID;

-- total_minor は、その費目の支出の合計（個別設定の支出を含む）。burden_minor はそのメンバーの負担額。
CREATE TABLE closing_category_burdens (
  group_id TEXT NOT NULL,
  closing_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  burden_minor INTEGER NOT NULL CHECK (burden_minor >= 0),
  PRIMARY KEY (closing_id, category_id, member_id),
  FOREIGN KEY (closing_id, group_id) REFERENCES monthly_closings (id, group_id),
  FOREIGN KEY (category_id, group_id) REFERENCES categories (id, group_id),
  FOREIGN KEY (member_id, group_id) REFERENCES group_members (id, group_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE settlement_transfers (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  closing_id TEXT NOT NULL,
  from_member_id TEXT NOT NULL,
  to_member_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'carried')),
  settled_at INTEGER,
  carried_at INTEGER,
  processed_by_member_id TEXT,
  FOREIGN KEY (closing_id, group_id) REFERENCES monthly_closings (id, group_id),
  FOREIGN KEY (from_member_id, group_id) REFERENCES group_members (id, group_id),
  FOREIGN KEY (to_member_id, group_id) REFERENCES group_members (id, group_id),
  FOREIGN KEY (processed_by_member_id, group_id) REFERENCES group_members (id, group_id),
  CHECK (from_member_id <> to_member_id),
  CHECK (
    (status = 'pending' AND settled_at IS NULL AND carried_at IS NULL AND processed_by_member_id IS NULL)
    OR (status = 'settled' AND settled_at IS NOT NULL AND carried_at IS NULL AND processed_by_member_id IS NOT NULL)
    OR (status = 'carried' AND carried_at IS NOT NULL AND settled_at IS NULL AND processed_by_member_id IS NOT NULL)
  ),
  UNIQUE (closing_id, from_member_id, to_member_id)
) STRICT, WITHOUT ROWID;
```

## A-7. DDLだけでは保証できないこと

以下は複数行・複数テーブルにまたがるため、Worker側の検証と8章の競合制御で保証する。

- `category_month_shares` の、1つの費目・月の割合合計が10000であること。
- `category_month_settings` と `category_month_shares` が同じ月でまとめて書かれること。上限額を負担する人が、その月の `category_month_shares` に含まれること。
- `expense_allocations.burden_minor` の合計が支出総額と一致すること。`category` の支出に行が無いこと。
- 金額指定の各 `amount_minor` の合計が支出総額と一致すること。
- 支払者・負担者が、支出の対象月に有効なメンバーであること。
- 月締め後に、対象月の支出・負担割合を変更できないこと。
- 送金の状態が `pending` からしか変わらないこと（UPDATEに `AND status = 'pending'` を付ける）。
- グループ通貨が支出登録後に変更されないこと。
- 匿名化時に `group_members.display_name` と `closing_member_summaries.display_name_snapshot` の両方を更新すること。
- `users` の削除前に、メンバー行の匿名化と `user_id` の解除を済ませること。
