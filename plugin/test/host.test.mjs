import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_REMOTE_STATE = join(mkdtempSync(join(tmpdir(), 'dsh-remote-host-')), 'state.json');
const { apply } = await import('../index.js');

function request(body, { method = 'POST', url } = {}) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = url || `/dsh-remote/${body.method}`;
  stream.headers = { 'content-type': 'application/json' };
  return stream;
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = '') { this.body += body; },
  };
}

async function mount({ rejection } = {}) {
  let route;
  const state = { effects: [] };
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { state.effects.push(fn()); },
    webServer: {
      register(value) { route = value; return () => {}; },
    },
    connection: {
      requestRejection() { return rejection; },
    },
    sessionController: {},
    agents: { get() { return undefined; } },
  };
  await apply(ctx);
  return { route, ctx, state };
}

async function invoke(route, req) {
  const res = response();
  await route.handler(req, res);
  return res;
}

test('settings route rejects unauthenticated requests', async () => {
  const { route } = await mount({ rejection: 401 });
  const res = await invoke(route, request({ type: 'client-request', rpcId: 'r1', method: 'config', payload: {} }));
  assert.equal(res.status, 401);
});

test('config and status are served over the JSON RPC envelope', async () => {
  const { route } = await mount();
  const config = await invoke(route, request({ type: 'client-request', rpcId: 'r1', method: 'config', payload: {} }));
  assert.equal(config.status, 200);
  const parsed = JSON.parse(config.body);
  assert.equal(parsed.type, 'server-response');
  assert.equal(parsed.rpcId, 'r1');
  assert.equal(parsed.result.ok, true);
  assert.equal(parsed.result.value.tokenConfigured, false);
  assert.match(parsed.result.value.relayUrl, /^ws:\/\//);

  const status = await invoke(route, request({ type: 'client-request', rpcId: 'r2', method: 'status', payload: {} }));
  const value = JSON.parse(status.body).result.value;
  assert.equal(value.state, 'disconnected');
  assert.equal(value.ready, false);
  assert.ok(value.harnessId);
});

test('configure validates the remote address and preserves the token flag', async () => {
  const { route } = await mount();
  const bad = await invoke(route, request({
    type: 'client-request', rpcId: 'r3', method: 'configure',
    payload: { relayUrl: 'http://not-a-websocket' },
  }));
  const badValue = JSON.parse(bad.body).result;
  assert.equal(badValue.ok, false);
  assert.equal(badValue.error.code, 'ERROR_CODE_INVALID_ARGUMENT');

  const good = await invoke(route, request({
    type: 'client-request', rpcId: 'r4', method: 'configure',
    payload: { relayUrl: 'ws://127.0.0.1:53299', displayName: 'Test Harness' },
  }));
  const value = JSON.parse(good.body).result.value;
  assert.equal(value.relayUrl, 'ws://127.0.0.1:53299');
  assert.equal(value.displayName, 'Test Harness');
});

test('pairing is unavailable while offline', async () => {
  const { route } = await mount();
  const res = await invoke(route, request({ type: 'client-request', rpcId: 'r5', method: 'pair.create', payload: {} }));
  const value = JSON.parse(res.body).result;
  assert.equal(value.ok, false);
  assert.match(value.error.message, /未|not online|offline|连接/i);
});
