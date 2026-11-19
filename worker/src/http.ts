// レスポンスと本文の読み取り。Singfolio（worker/src/http.ts）からのコピー（コピー元: singfolio 61e0a82）に、
// このアプリで足したもの（invalidRequest の field、notFound・forbidden・conflict）を加えた。
// Singfolio側を直したときは、差分を手で取り込む（docs/backend-design.md 1章）。

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    // 認証つきのデータを、どこにもキャッシュさせない。
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export const noContent = (): Response => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

/** 入力の不備。`field` は、直すべき項目の名前（クライアントが画面に出すための手がかり。値は返さない）。 */
export const invalidRequest = (field?: string): Response =>
  json(field === undefined ? { error: 'invalid_request' } : { error: 'invalid_request', field }, 400);
export const payloadTooLarge = (): Response => json({ error: 'payload_too_large' }, 413);
// 認証に失敗したときの応答。どの検査で落ちたかを、呼んだ側に教えない。
export const unauthorized = (): Response => json({ error: 'unauthorized' }, 401);
// グループのメンバーだが、その操作は許されない（脱退が確定した後の書き込み、参加前の月の閲覧など）。
export const forbidden = (): Response => json({ error: 'forbidden' }, 403);
// 無い、または見せない（他のグループのID、メンバーでない人。両者を区別しない）。
export const notFound = (): Response => json({ error: 'not_found' }, 404);
export const methodNotAllowed = (allow: string): Response => json({ error: 'method_not_allowed' }, 405, { allow });
/** 状態が合わない。`error` に理由の名前を入れる。アプリは、読み直して案内を出す。 */
export const conflict = (error: string, extra: Record<string, unknown> = {}): Response =>
  json({ error, ...extra }, 409);

// 本文を、上限を超えた時点で読むのをやめて返す（超えたら null）。`request.text()` は本文を全部
// メモリに読んでから大きさを測れるので使わない（Content-Length の無い chunked や、数値でない
// Content-Length では、宣言を当てにできない）。
async function readTextLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // 残りを読まない。取り消しの失敗は、応答に関係しない。
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export type JsonObjectResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

/**
 * 本文をJSONのオブジェクトとして読む。上限を超えたら413、JSONでない・オブジェクトでないなら400（どちらも
 * `response` を返す）。宣言（`Content-Length`）が上限を超えていれば、読まずに断る（早道。宣言が無い・
 * でたらめでも、読み込みが上限で止める）。
 */
export async function readJsonObject(request: Request, maxBytes: number): Promise<JsonObjectResult> {
  const declared = Number(request.headers.get('content-length'));
  if (declared > maxBytes) return { ok: false, response: payloadTooLarge() };
  const text = await readTextLimited(request, maxBytes);
  if (text === null) return { ok: false, response: payloadTooLarge() };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, response: invalidRequest() };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, response: invalidRequest() };
  }
  return { ok: true, body: body as Record<string, unknown> };
}
