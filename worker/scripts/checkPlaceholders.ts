/// <reference types="node" />
// デプロイの前に、wrangler.jsonc の vars に、まだ作っていない値の置き場所（仮の値）が残っていないか確かめる。
// `npm run deploy` の前に自動で走る（package.json の predeploy）。残っていれば、デプロイを止める。
// 仮の値のまま本番に出すと、Googleログインは、どのトークンも401になる（アプリからは、トークンの不正と見分けがつかない）。
// 仮の値には、`PLACEHOLDER_MARKER` を含める（wrangler.jsonc の GOOGLE_WEB_CLIENT_ID）。
// `wrangler deploy` を直接呼ぶと、この確認は走らない。デプロイは `npm run deploy` で行う。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';

export const PLACEHOLDER_MARKER = 'not-created-yet';

/** 仮の値が入っている var の名前。 */
export function placeholderVars(vars: Record<string, unknown>): string[] {
  return Object.entries(vars)
    .filter(([, value]) => typeof value === 'string' && value.includes(PLACEHOLDER_MARKER))
    .map(([name]) => name);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] === scriptPath) {
  const config = unstable_readConfig({ config: path.join(path.dirname(scriptPath), '..', 'wrangler.jsonc') });
  const found = placeholderVars((config.vars ?? {}) as Record<string, unknown>);
  if (found.length > 0) {
    console.error(`wrangler.jsonc の vars に、仮の値が残っています: ${found.join(', ')}`);
    console.error('実際の値に置き換えてから、デプロイしてください（docs/backend-design.md 12章）。');
    process.exit(1);
  }
}
