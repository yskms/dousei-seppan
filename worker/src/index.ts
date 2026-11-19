// 入口。エンドポイントは docs/backend-design.md 9章の順に足す。
import { handleCloseMonth, handleGetClosing, handleMonthSummary } from './closings.ts';
import { isId } from './expenseInput.ts';
import { handleCreateExpense, handleDeleteExpense, handleListExpenses, handleUpdateExpense } from './expenses.ts';
import { methodNotAllowed, notFound } from './http.ts';
import { httpsRequiredResponse, isInsecureRequest } from './https.ts';
import { isMonth } from './months.ts';
import { handleProcessTransfer } from './transfers.ts';

const GROUP_EXPENSES_PATH = /^\/groups\/([^/]+)\/expenses$/;
const EXPENSE_PATH = /^\/expenses\/([^/]+)$/;
const GROUP_MONTH_PATH = /^\/groups\/([^/]+)\/months\/([^/]+)\/(summary|close|closing)$/;
const TRANSFER_PATH = /^\/transfers\/([^/]+)\/(settle|carry)$/;

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

    const groupMonth = GROUP_MONTH_PATH.exec(pathname);
    if (groupMonth !== null) {
      const groupId = groupMonth[1]!;
      const month = groupMonth[2]!;
      if (!isId(groupId) || !isMonth(month)) return notFound();
      switch (groupMonth[3]) {
        case 'summary':
          if (request.method === 'GET') return handleMonthSummary(request, env, now, groupId, month);
          return methodNotAllowed('GET');
        case 'closing':
          if (request.method === 'GET') return handleGetClosing(request, env, now, groupId, month);
          return methodNotAllowed('GET');
        default:
          if (request.method === 'POST') return handleCloseMonth(request, env, now, groupId, month);
          return methodNotAllowed('POST');
      }
    }

    const transfer = TRANSFER_PATH.exec(pathname);
    if (transfer !== null) {
      const transferId = transfer[1]!;
      if (!isId(transferId)) return notFound();
      if (request.method !== 'POST') return methodNotAllowed('POST');
      return handleProcessTransfer(request, env, now, transferId, transfer[2] === 'settle' ? 'settle' : 'carry');
    }

    // 他の404と同じ形にする（アプリがエラーをJSONとして読めるように）。
    return notFound();
  },
} satisfies ExportedHandler<Env>;
