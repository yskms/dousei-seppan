/// <reference types="node" />
// HTTPSでないリクエストの拒否（src/https.ts）。Singfolio（worker/test/https.test.ts）に合わせた。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { httpsRequiredResponse, isInsecureRequest } from '../src/https.ts';

const insecure = (url: string, headers?: Record<string, string>) => isInsecureRequest(new Request(url, { headers }));

describe('isInsecureRequest', () => {
  it('https は通し、http は拒否する', () => {
    assert.equal(insecure('https://example.test/groups'), false);
    assert.equal(insecure('http://example.test/groups'), true);
  });

  it('ローカルの開発（localhost・127.0.0.1・[::1]）の http だけ通す', () => {
    assert.equal(insecure('http://localhost:8787/groups'), false);
    assert.equal(insecure('http://127.0.0.1:8787/groups'), false);
    assert.equal(insecure('http://[::1]:8787/groups'), false);
  });

  it('localhost に似たホスト名は通さない（完全一致だけ）', () => {
    assert.equal(insecure('http://localhost.evil.example/'), true);
    assert.equal(insecure('http://127.0.0.1.evil.example/'), true);
    assert.equal(insecure('http://evil.example/localhost'), true);
  });

  it('X-Forwarded-Proto が http なら、URLが https でも拒否する。https と書いてあっても、URLが http なら拒否する', () => {
    assert.equal(insecure('https://example.test/', { 'x-forwarded-proto': 'http' }), true);
    assert.equal(insecure('https://example.test/', { 'x-forwarded-proto': 'https, http' }), true);
    assert.equal(insecure('https://example.test/', { 'x-forwarded-proto': 'https' }), false);
    assert.equal(insecure('http://example.test/', { 'x-forwarded-proto': 'https' }), true);
  });
});

describe('httpsRequiredResponse', () => {
  it('403 で、リダイレクトしない・キャッシュさせない', async () => {
    const response = httpsRequiredResponse();
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
