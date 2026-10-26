import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from '../lib/proto.js';
import { SessionBridge } from '../lib/sessions.js';

process.env.DSH_REMOTE_STATE = join(mkdtempSync(join(tmpdir(), 'dsh-remote-test-')), 'state.json');

const NOW = Date.now();
const events = [
  { type: 'turn/start', seq: 1, time: NOW, data: { turn: 1 } },
  {
    type: 'user/message', seq: 2, time: NOW,
    data: { message: { id: 'm1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
  },
  {
    type: 'assistant/message', seq: 3, time: NOW,
    data: {
      message: { id: 'a1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 1, outputTokens: 2 },
    },
  },
  { type: 'tool/call', seq: 4, time: NOW, data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"pwd"}' } },
  {
    type: 'tool/result', seq: 5, time: NOW,
    data: { message: { id: 't1', toolCallId: 'c1', content: [{ type: 'text', text: '/tmp' }] } },
  },
  { type: 'turn/end', seq: 6, time: NOW, data: { turn: 1, reason: { kind: 'completed' } } },
];

class FakeAdapter extends EventEmitter {
  sent = [];
  sendEvent(operation, payload, options) {
    this.sent.push({ operation, payload, options });
    return true;
  }
}

function makeContext() {
  return {
    sessionController: {
      async list() {
        return { items: [
          { sessionId: 's1', updatedAt: NOW, cwd: '/work/project-one', projections: { asOfSeq: 6, values: { title: 'Project One' } } },
          { sessionId: 'local-1', updatedAt: NOW - 1000, cwd: '/work/Local Project', projections: { asOfSeq: 0, values: {} } },
        ] };
      },
      async create() { return { sessionId: 's1' }; },
      async rename(request) { this.lastRename = request; return { title: request.title, seq: 7 }; },
      async inspect(sessionId) {
        if (sessionId !== 's1' && sessionId !== 'local-1') {
          const error = new Error('not found');
          error.code = 'session/not-found';
          throw error;
        }
        return { meta: { id: sessionId, createdAt: NOW, cwd: '/work/project-one' }, events };
      },
      async resolveAgent() { return { agent: { id: 's1' } }; },
      async prompt(request, signal) {
        if (!signal) throw new Error('prompt requires an AbortSignal');
        this.lastPrompt = request;
        return { accepted: true };
      },
      cancel() { return { accepted: true }; },
      async selectModel(request) { return { selected: request }; },
      async modelCatalog() {
        return { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }] };
      },
      follow() {
        return (async function* () {
          yield {
            type: 'snapshot', cursor: 6, header: { id: 's1' },
            records: events.map((event) => ({ type: 'event', event })),
            projections: { asOfSeq: 6, values: {} },
          };
          yield { type: 'event', event: events[5] };
          yield {
            type: 'assistant-stream',
            frame: { type: 'chunk', attemptId: 'a2', revision: 1, index: 0, chunk: { type: 'text-delta', text: 'partial' } },
          };
        })();
      },
    },
    get(name) { return name === 'agentDefaultModel' ? this.agentDefaultModel : undefined; },
    agents: { get: () => ({ id: 's1', status: 'running', session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
}

function bridgeFor() {
  const state = { registrationToken: '', relayUrl: 'ws://x' };
  const adapter = new FakeAdapter();
  const bridge = new SessionBridge({ ctx: makeContext(), adapter, state });
  adapter.handlers = bridge.handlers;
  return { bridge, adapter, state };
}

const principal = { user_id: 'u1', device_id: 'd1', roles: [1], acl_version: 1 };
const other = { user_id: 'u2', device_id: 'd2', roles: [2], acl_version: 1 };
const forward = { route_id: 'r1', connection_id: 'c1' };

test('session list/create/open/snapshot/page produce valid HRP messages', async () => {
  const { adapter, state } = bridgeFor();
  const created = await adapter.handlers.session_create({ title: 'Remote chat', mutation: { client_operation_id: 'create-1' } }, { principal });
  encode('hrp.v1.SessionCreateResponse', created);
  assert.equal(created.baseline.session.title, 'Remote chat');
  assert.equal(state.remoteSessions, undefined);

  const list = await adapter.handlers.session_list({}, { principal });
  encode('hrp.v1.SessionListResponse', list);
  assert.equal(list.sessions.length, 2);
  assert.deepEqual(list.sessions.map((session) => session.title).sort(), ['Local Project', 'Project One']);
  assert.equal(list.sessions.find((session) => session.session_id === 's1').workspace, '/work/project-one');

  const firstPage = await adapter.handlers.session_list({ page_size: 1 }, { principal });
  assert.equal(firstPage.sessions.length, 1);
  assert.equal(firstPage.has_more, true);
  assert.ok(firstPage.next_page_token);
  const secondPage = await adapter.handlers.session_list({ page_size: 1, page_token: firstPage.next_page_token }, { principal });
  assert.equal(secondPage.sessions.length, 1);
  assert.equal(secondPage.has_more, false);
  assert.notEqual(secondPage.sessions[0].session_id, firstPage.sessions[0].session_id);

  const opened = await adapter.handlers.session_open({ session_id: 's1', resume_agent: true, mutation: { client_operation_id: 'open-1' } }, { principal });
  encode('hrp.v1.SessionOpenResponse', opened);
  assert.equal(opened.baseline.tail.length, 6);
  assert.equal(opened.baseline.session.committed_seq, 6);

  const snapshot = await adapter.handlers.session_snapshot({ session_id: 's1', tail_limit: 2 }, { principal });
  encode('hrp.v1.SessionSnapshotResponse', snapshot);
  assert.equal(snapshot.baseline.tail.length, 2);

  const page = await adapter.handlers.session_page({ session_id: 's1', after_seq: 4, page_size: 1 }, { principal });
  encode('hrp.v1.SessionPageResponse', page);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].session_seq, 5);
  assert.equal(page.events[0].tool_result.call_id, 'c1');
});

test('every member sees the same native directory; unknown sessions stay hidden', async () => {
  const { adapter } = bridgeFor();
  await adapter.handlers.session_create({ mutation: { client_operation_id: 'create-2' } }, { principal });
  const opened = await adapter.handlers.session_open({ session_id: 's1', mutation: { client_operation_id: 'open-2' } }, { principal: other });
  encode('hrp.v1.SessionOpenResponse', opened);
  assert.equal(opened.baseline.session.session_id, 's1');
  await assert.rejects(
    adapter.handlers.session_snapshot({ session_id: 'nope' }, { principal }),
    (error) => error.code === 'ERROR_CODE_SESSION_NOT_FOUND',
  );
});

test('agent prompts are admitted and status is mapped', async () => {
  const { adapter } = bridgeFor();
  await adapter.handlers.session_create({ mutation: { client_operation_id: 'create-2' } }, { principal });
  const sent = await adapter.handlers.agent_send({
    session_id: 's1', message_id: 'msg1', mode: 1, content: [{ text: 'do work' }],
    mutation: { client_operation_id: 'send-1' },
  }, { principal });
  encode('hrp.v1.AgentSendResponse', sent);
  assert.equal(sent.state, 1);
  const status = await adapter.handlers.agent_status({ session_id: 's1' }, { principal });
  encode('hrp.v1.AgentStatusResponse', status);
  assert.equal(status.agent.state, 2);
  const cancel = await adapter.handlers.agent_cancel({ session_id: 's1', mutation: { client_operation_id: 'cancel-1' } }, { principal });
  assert.equal(cancel.cancel_requested, true);
});

test('follow returns a baseline before streaming and unfollow stops it', async () => {
  const { adapter } = bridgeFor();
  await adapter.handlers.session_create({ mutation: { client_operation_id: 'create-2' } }, { principal });
  const follow = await adapter.handlers.session_follow({ session_id: 's1', tail_limit: 10 }, { principal, forward });
  encode('hrp.v1.SessionFollowResponse', follow);
  assert.ok(follow.subscription_id);
  assert.equal(follow.baseline.cursor, 6);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(adapter.sent.some((entry) => entry.operation === 'assistant_live_chunk'));
  assert.ok(adapter.sent.some((entry) => entry.operation === 'session_committed'));
  await adapter.handlers.session_unfollow({ subscription_id: follow.subscription_id }, { principal, forward });
});

test('mutations are idempotent and conflicting reuse is rejected', async () => {
  const { adapter } = bridgeFor();
  const request = { title: 'Once', mutation: { client_operation_id: 'same-id' } };
  const first = await adapter.handlers.session_create(request, { principal });
  const replay = await adapter.handlers.session_create(request, { principal });
  assert.deepEqual(replay, first);
  await assert.rejects(
    adapter.handlers.session_create({ title: 'Different', mutation: { client_operation_id: 'same-id' } }, { principal }),
    (error) => error.code === 'ERROR_CODE_IDEMPOTENCY_CONFLICT',
  );
});

test('model operations encode and map', async () => {
  const { adapter } = bridgeFor();
  await adapter.handlers.session_create({ mutation: { client_operation_id: 'create-2' } }, { principal });
  const current = await adapter.handlers.model_current({ session_id: 's1' }, { principal });
  encode('hrp.v1.ModelCurrentResponse', current);
  assert.equal(current.selection.model, 'm');
  const list = await adapter.handlers.model_list({ session_id: 's1' }, { principal });
  encode('hrp.v1.ModelListResponse', list);
  assert.equal(list.models.length, 1);
  const selected = await adapter.handlers.model_select({
    session_id: 's1', selection: { provider: 'p', model: 'm' },
    mutation: { client_operation_id: 'select-1' },
  }, { principal });
  encode('hrp.v1.ModelSelectResponse', selected);
  assert.equal(selected.selection.model, 'm');
});
