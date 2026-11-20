// 入口。エンドポイントは docs/backend-design.md 9章の順に足す。
import { handleCloseMonth, handleGetClosing, handleMonthSummary } from './closings.ts';
import { runScheduled } from './cron.ts';
import { isId } from './expenseInput.ts';
import { handleCreateExpense, handleDeleteExpense, handleListExpenses, handleUpdateExpense } from './expenses.ts';
import { methodNotAllowed, notFound } from './http.ts';
import { httpsRequiredResponse, isInsecureRequest } from './https.ts';
import {
  handleCreateInvite,
  handleGetInvite,
  handleJoin,
  handleListInvites,
  handleRevokeInvite,
  isInviteToken,
} from './invites.ts';
import { handleCancelLeave, handleRequestLeave } from './leave.ts';
import { isMonth } from './months.ts';
import { handleProcessTransfer } from './transfers.ts';

const GROUP_EXPENSES_PATH = /^\/groups\/([^/]+)\/expenses$/;
const EXPENSE_PATH = /^\/expenses\/([^/]+)$/;
const GROUP_MONTH_PATH = /^\/groups\/([^/]+)\/months\/([^/]+)\/(summary|close|closing)$/;
const TRANSFER_PATH = /^\/transfers\/([^/]+)\/(settle|carry)$/;
const GROUP_INVITES_PATH = /^\/groups\/([^/]+)\/invites$/;
const GROUP_LEAVE_PATH = /^\/groups\/([^/]+)\/leave$/;
// `/invites/:x` は、GET が招待トークン、DELETE が招待のID。
const INVITE_PATH = /^\/invites\/([^/]+)$/;
const INVITE_JOIN_PATH = /^\/invites\/([^/]+)\/join$/;

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

    const groupInvites = GROUP_INVITES_PATH.exec(pathname);
    if (groupInvites !== null) {
      const groupId = groupInvites[1]!;
      if (!isId(groupId)) return notFound();
      if (request.method === 'GET') return handleListInvites(request, env, now, groupId);
      if (request.method === 'POST') return handleCreateInvite(request, env, now, groupId);
      return methodNotAllowed('GET, POST');
    }

    const groupLeave = GROUP_LEAVE_PATH.exec(pathname);
    if (groupLeave !== null) {
      const groupId = groupLeave[1]!;
      if (!isId(groupId)) return notFound();
      if (request.method === 'POST') return handleRequestLeave(request, env, now, groupId);
      if (request.method === 'DELETE') return handleCancelLeave(request, env, now, groupId);
      return methodNotAllowed('POST, DELETE');
    }

    const invite = INVITE_PATH.exec(pathname);
    if (invite !== null) {
      const value = invite[1]!;
      if (request.method === 'GET') return isInviteToken(value) ? handleGetInvite(request, env, now, value) : notFound();
      if (request.method === 'DELETE') return isId(value) ? handleRevokeInvite(request, env, now, value) : notFound();
      return methodNotAllowed('GET, DELETE');
    }

    const inviteJoin = INVITE_JOIN_PATH.exec(pathname);
    if (inviteJoin !== null) {
      const token = inviteJoin[1]!;
      if (!isInviteToken(token)) return notFound();
      if (request.method === 'POST') return handleJoin(request, env, now, token);
      return methodNotAllowed('POST');
    }

    // 他の404と同じ形にする（アプリがエラーをJSONとして読めるように）。
    return notFound();
  },

  // 1時間ごとの定期処理（wrangler.jsonc の triggers。docs/backend-design.md 7章）。
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runScheduled(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
