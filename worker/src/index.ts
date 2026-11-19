// 入口。エンドポイントは docs/backend-design.md 9章の順に足す。
import { isId } from './expenseInput.ts';
import { handleCreateExpense, handleDeleteExpense, handleListExpenses, handleUpdateExpense } from './expenses.ts';
import { notFound, methodNotAllowed } from './http.ts';
import { httpsRequiredResponse, isInsecureRequest } from './https.ts';

const GROUP_EXPENSES_PATH = /^\/groups\/([^/]+)\/expenses$/;
const EXPENSE_PATH = /^\/expenses\/([^/]+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 何よりも先に、HTTPSでないリクエストを、中身を見ずに拒否する（src/https.ts）。
    if (isInsecureRequest(request)) return httpsRequiredResponse();

    const { pathname } = new URL(request.url);
    const now = Date.now();

    const groupExpenses = GROUP_EXPENSES_PATH.exec(pathname);
    if (groupExpenses !== null) {
      const groupId = groupExpenses[1]!;
      if (!isId(groupId)) return notFound();
      if (request.method === 'GET') return handleListExpenses(request, env, now, groupId);
      if (request.method === 'POST') return handleCreateExpense(request, env, now, groupId);
      return methodNotAllowed('GET, POST');
    }

    const expense = EXPENSE_PATH.exec(pathname);
    if (expense !== null) {
      const expenseId = expense[1]!;
      if (!isId(expenseId)) return notFound();
      if (request.method === 'PATCH') return handleUpdateExpense(request, env, now, expenseId);
      if (request.method === 'DELETE') return handleDeleteExpense(request, env, now, expenseId);
      return methodNotAllowed('PATCH, DELETE');
    }

    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
} satisfies ExportedHandler<Env>;
