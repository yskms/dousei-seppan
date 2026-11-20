// 固定費のAPIのテストで使う、呼び出しの道具（monthApi.ts と同じ作り）。
import { handleCreateRecurring, handleListRecurring, handleUpdateRecurring } from '../src/recurring.ts';
import { NOW, type Person } from './apiFixture.ts';
import { read, request, type ApiResult } from './monthApi.ts';

interface Options {
  now?: number;
  env?: Env;
}

/** 各APIの呼び出し。`who` が null なら、セッション無し。 */
export function recurringApi(defaultEnv: Env) {
  const opts = (options: Options) => [options.env ?? defaultEnv, options.now ?? NOW] as const;
  const token = (who: Person | null) => who?.token ?? null;
  return {
    list: async (who: Person | null, groupId: string, options: Options = {}): Promise<ApiResult> =>
      read(await handleListRecurring(request('GET', `/groups/${groupId}/recurring-expenses`, token(who)), ...opts(options), groupId)),
    create: async (who: Person | null, groupId: string, body: unknown, options: Options = {}): Promise<ApiResult> =>
      read(await handleCreateRecurring(request('POST', `/groups/${groupId}/recurring-expenses`, token(who), body), ...opts(options), groupId)),
    update: async (who: Person | null, recurringId: string, body: unknown, options: Options = {}): Promise<ApiResult> =>
      read(await handleUpdateRecurring(request('PATCH', `/recurring-expenses/${recurringId}`, token(who), body), ...opts(options), recurringId)),
  };
}
