// ログインの処理（IDトークンの検証から、セッションの発行まで）。Singfolio（worker/src/login.ts）からのコピー
// （コピー元: singfolio 61e0a82）のうち、ネイティブのサインイン（iOSのApple、iOS・AndroidのGoogle）だけ。
// コメントの「§8」は Singfolio の docs の章番号で、ここでは読めない。
// コピーしていないもの: AndroidのAppleログイン（Web経由。`kind: 'web'` の `V` の照合と、認可コードの交換）。
// `/auth/apple/login` と一緒に、あとで同じ元から取り込む（docs/backend-design.md 12章）。
// Singfolio側を直したときは、差分を手で取り込む（docs/backend-design.md 1章）。
//
// 順序と理由は、Singfolio の docs/singfolio-publishing-backend.md §8「認証の方式」の「ログインの処理の順序」。
// D1に書くのは、IDトークンの検証まで通ったあと。それより前の検査は、D1にも外部にも触れない。
import { audienceFor, type IdTokenProvider, type IdTokenVerifier } from './idToken.ts';
import { resolveIdentity } from './identity.ts';
import { consumeNonce, verifyNonce } from './nonce.ts';
import { createSession } from './session.ts';

/** ネイティブのサインイン。`native` の `T`（`POST /auth/nonce`。IDトークンの `nonce` は、SHA-256(T)）、アプリが得たIDトークン。 */
export interface NativeSignInInput {
  provider: IdTokenProvider;
  kind: 'native';
  nonce: string;
  idToken: string;
}

export type SignInInput = NativeSignInInput;

// `rejected` は、どの検査で落ちたかを教えない（呼ぶ側は同じ401にする）。`unavailable` は、
// 公開鍵を取得できないこと（トークンの問題ではないので、アプリがやり直せる）。
export type SignInResult = { ok: true; session: string } | { ok: false; reason: 'rejected' | 'unavailable' };

const rejected: SignInResult = { ok: false, reason: 'rejected' };

export async function signIn(
  env: Env,
  verifier: IdTokenVerifier,
  input: SignInInput,
  now: number,
): Promise<SignInResult> {
  const { provider, kind, nonce, idToken } = input;
  // 1. `T` の署名・種別・期限。D1にも外部にも触れない。
  const verifiedNonce = await verifyNonce(env.NONCE_HMAC_KEY, nonce, kind, now);
  if (!verifiedNonce.ok) return rejected;

  // 2. 受け付ける `aud`。無い組み合わせは拒否する。公開鍵を取りに行く前に弾く。
  const audience = audienceFor(env, provider, kind);
  if (audience === null) return rejected;

  // 3. IDトークンの検証（`nonce` が SHA-256(T) と一致するところまで）。
  const verified = await verifier.verify({ provider, idToken, audience, nonce: verifiedNonce.nonceHash, now });
  if (!verified.ok) return { ok: false, reason: verified.reason === 'unavailable' ? 'unavailable' : 'rejected' };

  // 4. ここから先がD1への書き込み。`T` を使用済みにする（2回目は弾く）。このあとD1が失敗しても `T` は
  //    使い切りになる（アプリが新しい `T` で、やり直す）。
  if (!(await consumeNonce(env.DB, verifiedNonce.nonceHash, verifiedNonce.expiresAt, now))) return rejected;

  // 5. ログイン手段の引き当て（無ければユーザーごと作る）、6. セッションの発行。
  //    セッションを作らないことがある（`createSession`。Appleの通知との競合を吸収する）。理由は教えず、401にする。
  const { identityId } = await resolveIdentity(env.DB, provider, verified.sub, now);
  const session = await createSession(env.DB, identityId, now);
  return session === null ? rejected : { ok: true, session };
}
