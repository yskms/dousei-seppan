/// <reference types="node" />
// wrangler.jsonc の、変えてはいけない方針を固定する。Singfolio（worker/test/config.test.ts）のうち、このアプリにあるものだけ
// （コピー元: singfolio 61e0a82）。変えるときは、docs/backend-design.md と一緒に直す。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { unstable_readConfig } from 'wrangler';
import { workerDir } from './localDatabase.ts';

const config = unstable_readConfig({ config: path.join(workerDir, 'wrangler.jsonc') });
const vars = (config.vars ?? {}) as Record<string, unknown>;

// Google Cloudで、サーバー用（Web）のクライアントIDを作るまでの、実在しない値（wrangler.jsonc）。
const GOOGLE_PLACEHOLDER = '0-not-created-yet.apps.googleusercontent.com';

describe('wrangler.jsonc', () => {
  it('Workers Logs は無効（認証の値が、ログに残らないようにするため）', () => {
    // 資料は、記録に含まれるヘッダー（Authorization など）と、invocation_logs を false にしたときの
    // console.log のメタデータを書いていない。確かめずに有効にしない。
    assert.equal(config.observability?.enabled, false);
    // 有効にされても、クエリ文字列（招待の値など）をログに残さないための安全弁。
    assert.equal(config.observability?.redact_query_string, true);
  });

  it('workers.dev とプレビューのURLは出さない', () => {
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
  });

  it('秘密情報は wrangler.jsonc に値を書かない（vars に置かない）', () => {
    assert.equal(config.secrets?.required?.includes('NONCE_HMAC_KEY'), true);
    for (const name of config.secrets?.required ?? []) {
      assert.equal(name in vars, false, `${name} を vars に置かない`);
    }
  });

  it('IDトークンの aud（vars）は、アプリの設定と食い違っていない', () => {
    const app = JSON.parse(readFileSync(path.join(workerDir, '..', 'app.json'), 'utf8')) as {
      expo: { ios: { bundleIdentifier: string } };
    };
    // Appleのネイティブのトークンの aud は、アプリのバンドルID（iOS）。ずれると、すべてのAppleログインが拒否される。
    assert.equal(vars.APPLE_BUNDLE_ID, app.expo.ios.bundleIdentifier);
    // Googleの aud は、サーバー用（Web）のクライアントID。iOS・Androidのクライアントではない。
    // まだ作っていない間は、実在しない値のまま（Googleログインは、どのトークンも拒否される）。
    assert.ok(
      vars.GOOGLE_WEB_CLIENT_ID === GOOGLE_PLACEHOLDER ||
        /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(String(vars.GOOGLE_WEB_CLIENT_ID)),
      'GOOGLE_WEB_CLIENT_ID が、クライアントIDの形でも、置き場所の値でもない',
    );
  });

  it('HTTPS検査を迂回する設定を vars に置かない', () => {
    // 検査は、localhost のホスト名だけを通す。環境変数などで切る口は作らない（src/https.ts）。
    for (const name of Object.keys(vars)) {
      assert.doesNotMatch(name, /insecure|http|ssl|tls/i, `${name}: HTTPS検査を切る口にならないか確認する`);
    }
  });

  it('.dev.vars.example に、必須の秘密情報がすべて載っている', () => {
    const example = readFileSync(path.join(workerDir, '.dev.vars.example'), 'utf8');
    for (const name of config.secrets?.required ?? []) {
      assert.match(example, new RegExp(`^${name}=`, 'm'), `${name} が .dev.vars.example に無い`);
    }
  });
});
