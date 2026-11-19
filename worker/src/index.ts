// 入口。エンドポイントは docs/backend-design.md 9章の順に足す。
export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
} satisfies ExportedHandler<Env>;
