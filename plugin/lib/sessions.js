import { createHash, randomUUID } from 'node:crypto';
import { AdapterError, forbidden, invalid, unsupported } from './adapter.js';
import { saveState } from './identity.js';

const TERMINAL = new Set(['turn/end', 'assistant/message']);
const MUTATING = new Set([
  'session_create', 'session_open', 'agent_send', 'agent_cancel',
  'approval_decide', 'approval_policy_set', 'model_select',
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('operation timed out')), ms);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function timestamp(ms) {
  const value = Number(ms || 0);
  return { seconds: Math.floor(value / 1000), nanos: Math.round((value % 1000) * 1e6) };
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
  } catch {
    return { raw: text };
  }
}

function textOf(blocks) {
  return (blocks || [])
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function contentBlock(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'text') return { text: String(block.text ?? '') };
  if (block.type === 'reasoning') return { reasoning: String(block.text ?? '') };
  if (block.type === 'tool-call') {
    return {
      tool_call: {
        call_id: String(block.id ?? ''),
        tool_name: String(block.name ?? ''),
        arguments: parseJsonObject(block.arguments),
      },
    };
  }
  if (block.type === 'image') return { text: '[image]' };
  if (block.type === 'file') return { text: '[file]' };
  return null;
}

function mapContent(blocks) {
  return (blocks || []).map(contentBlock).filter(Boolean);
}

function basename(path) {
  if (typeof path !== 'string' || path === '') return '';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

function titleFromEvents(events) {
  for (let index = (events?.length || 0) - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') {
      return event.data.title;
    }
  }
  return '';
}

function displayTitle(row, events) {
  const eventTitle = titleFromEvents(events);
  if (eventTitle) return eventTitle;
  const projected = row?.projections?.values?.title;
  if (typeof projected === 'string' && projected !== '') return projected;
  const directory = basename(row?.cwd);
  if (directory) return directory;
  return String(row?.sessionId || row?.session_id || '');
}

function agentState(agent) {
  if (!agent) return 3; // AGENT_STATE_UNLOADED
  return agent.status === 'running' ? 2 : 1;
}

function turnOutcome(reason) {
  const kind = reason?.kind;
  if (kind === 'completed') return 'completed';
  if (kind === 'aborted') return 'cancelled';
  if (kind === 'blocked') return 'blocked';
  if (kind === 'error') return 'error';
  if (kind === 'max-tokens') return 'max_tokens';
  if (kind === 'interrupted') return 'interrupted';
  if (kind === 'forked') return 'forked';
  return 'completed';
}

function mapEvent(event, principal) {
  const base = {
    session_seq: Number(event.seq || 0),
    committed_at: timestamp(event.time),
    event_type: String(event.type || 'event'),
  };
  const data = event.data || {};
  switch (event.type) {
    case 'user/message': {
      const message = data.message || {};
      const source = message.source || {};
      return {
        ...base,
        user_message: {
          message_id: String(message.id || ''),
          content: mapContent(message.content),
          source: {
            user_id: source.userId || principal?.user_id || '',
            device_id: principal?.device_id || '',
            channel: source.kind === 'user' ? 'dsh' : String(source.kind || ''),
          },
        },
      };
    }
    case 'assistant/message': {
      const message = data.message || {};
      return {
        ...base,
        assistant_message: {
          attempt_id: String(message.id || ''),
          revision: 1,
          content: mapContent(message.content),
          outcome: 'completed',
        },
      };
    }
    case 'assistant/attempt':
      return {
        ...base,
        assistant_attempt: {
          attempt_id: String(data.message?.id || event.attemptId || ''),
          revision: 1,
          content: mapContent(data.message?.content),
          outcome: 'attempt',
        },
      };
    case 'tool/call':
      return {
        ...base,
        tool_call: {
          call_id: String(data.callId || ''),
          tool_name: String(data.name || ''),
          arguments: parseJsonObject(data.arguments),
        },
      };
    case 'tool/result':
      return {
        ...base,
        tool_result: {
          call_id: String(data.message?.toolCallId || data.callId || ''),
          content: mapContent(data.message?.content),
          is_error: Boolean(data.error || data.message?.isError),
        },
      };
    case 'turn/start':
      return { ...base, lifecycle: { outcome: 'running' } };
    case 'turn/end':
      return { ...base, lifecycle: { outcome: turnOutcome(data.reason), reason: data.reason?.kind } };
    case 'model/selection':
    case 'model/selected': {
      const selection = data.selection || data;
      if (selection && selection.provider && selection.model) {
        return {
          ...base,
          model_selection: {
            provider: String(selection.provider),
            model: String(selection.model),
            ...(selection.reasoningEffort || selection.reasoning_effort
              ? { reasoning_effort: String(selection.reasoningEffort || selection.reasoning_effort) }
              : {}),
          },
        };
      }
      break;
    }
    case 'approval/asked':
      return {
        ...base,
        approval: {
          approval_id: String(data.approvalId || data.id || ''),
          call_id: data.callId ? String(data.callId) : undefined,
          outcome: 0,
        },
      };
    case 'approval/decided': {
      const outcome = data.decision === 'allow' || data.outcome === 'allowed' || data.outcome === 'allowed-once'
        ? 1
        : data.outcome === 'rejected'
          ? 2
          : data.outcome === 'cancelled'
            ? 3
            : 4;
      return {
        ...base,
        approval: {
          approval_id: String(data.approvalId || data.id || ''),
          call_id: data.callId ? String(data.callId) : undefined,
          outcome,
        },
      };
    }
    default:
      break;
  }
  const payload = Buffer.from(JSON.stringify(data), 'utf8');
  return {
    ...base,
    extension: {
      namespace: 'dsh',
      event_type: String(event.type || 'event'),
      schema_version: 1,
      media_type: 'application/json',
      payload,
    },
  };
}

function projectionMessages(events, principal) {
  const messages = [];
  for (const event of events) {
    if (event.type === 'user/message') {
      const message = event.data?.message;
      if (message) messages.push({
        message_id: String(message.id || ''),
        role: 'user',
        content: mapContent(message.content),
      });
    } else if (event.type === 'assistant/message') {
      const message = event.data?.message;
      if (message) messages.push({
        message_id: String(message.id || ''),
        role: 'assistant',
        content: mapContent(message.content),
      });
    }
  }
  return messages;
}

export class SessionBridge {
  constructor({ ctx, adapter, state, logger = console }) {
    this.ctx = ctx;
    this.adapter = adapter;
    this.state = state;
    if (!this.state.receipts || typeof this.state.receipts !== 'object') this.state.receipts = {};
    this.logger = logger;
    this.subscriptions = new Map();
    this.adapter.on('connection-closed', (connectionId) => this.closeConnection(connectionId));
    this.adapter.on('offline', () => this.closeAll('relay disconnected'));
    const handlers = this.#handlers();
    this.handlers = {};
    for (const [operation, handler] of Object.entries(handlers)) {
      this.handlers[operation] = MUTATING.has(operation)
        ? (payload, context) => this.#withReceipt(operation, payload, context, handler)
        : handler;
    }
  }

  #controller() {
    return this.ctx.sessionController;
  }

  #live(sessionId) {
    return this.ctx.agents?.get?.(sessionId);
  }

  #summary(sessionId, cursor, updatedAt, title, workspace = '') {
    const live = this.#live(sessionId);
    return {
      session_id: sessionId,
      title: title || String(sessionId),
      committed_seq: Number(cursor || 0),
      agent_state: agentState(live),
      updated_at: timestamp(updatedAt || Date.now()),
      workspace: workspace || '',
    };
  }

  #baseline(sessionId, events, cursor, tailLimit = 50, fallbackTitle = '', workspace = '') {
    const seq = Number(cursor || 0);
    const title = titleFromEvents(events) || fallbackTitle || String(sessionId);
    return {
      session: this.#summary(sessionId, seq, events[events.length - 1]?.time, title, workspace),
      cursor: seq,
      projection: {
        schema_version: 1,
        data: {
          messages: projectionMessages(events, undefined),
          active_turn_id: null,
        },
      },
      tail: events.slice(-Math.max(0, tailLimit || 0)).map((event) => mapEvent(event, undefined)),
      active_attempts: [],
    };
  }

  #pageOffset(token, principal) {
    if (token === undefined || token === null || token === '') return 0;
    try {
      const parsed = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
      if (parsed.u !== principal.user_id || !Number.isInteger(parsed.o) || parsed.o < 0) throw new Error('mismatch');
      return parsed.o;
    } catch {
      throw invalid('invalid session page token');
    }
  }

  #pageToken(offset, principal) {
    return Buffer.from(JSON.stringify({ u: principal.user_id, o: offset }), 'utf8').toString('base64url');
  }

  async #inspect(sessionId) {
    const timeout = timeoutSignal(15_000);
    try {
      return await this.#controller().inspect(sessionId, timeout.signal);
    } catch (error) {
      throw this.#mapRemoteError(error);
    } finally {
      timeout.clear();
    }
  }

  #assertMode(value) {
    if (![1, 2].includes(value)) throw invalid('mode must be followup or steer');
  }

  #mapContentToPrompt(content) {
    const parts = [];
    for (const block of content || []) {
      if (block.text !== undefined) parts.push({ type: 'text', text: String(block.text) });
      else if (block.reasoning !== undefined) continue;
      else throw unsupported('only text content is supported for remote prompts');
    }
    if (parts.length === 0) throw invalid('message has no text content');
    return parts;
  }

  #mapRemoteError(error) {
    const code = error?.code;
    if (code === 'session/not-found') return new AdapterError('ERROR_CODE_SESSION_NOT_FOUND', error.message);
    if (code === 'session/agent-busy') return new AdapterError('ERROR_CODE_AGENT_BUSY', error.message);
    if (code === 'gateway/cancelled') return new AdapterError('ERROR_CODE_INTERNAL', error.message);
    return new AdapterError('ERROR_CODE_INTERNAL', error?.message || String(error));
  }

  async #withReceipt(operation, payload, context, handler) {
    const operationId = payload?.mutation?.client_operation_id;
    if (!operationId) {
      if (operation === 'session_open' && !payload?.resume_agent) return handler(payload, context);
      throw invalid('mutation.client_operation_id is required');
    }
    const principal = context?.principal;
    if (!principal?.user_id) throw forbidden('missing principal for idempotent operation');
    const key = `${principal.user_id}:${operationId}`;
    const digest = createHash('sha256').update(JSON.stringify(canonical([operation, payload]))).digest('hex');
    const existing = this.state.receipts[key];
    if (existing) {
      if (existing.digest !== digest) {
        throw new AdapterError('ERROR_CODE_IDEMPOTENCY_CONFLICT', 'client_operation_id was reused with a different request');
      }
      return JSON.parse(JSON.stringify(existing.response));
    }
    const response = await handler(payload, context);
    const now = Date.now();
    this.state.receipts[key] = { digest, response: JSON.parse(JSON.stringify(response)), at: now };
    const entries = Object.entries(this.state.receipts);
    if (entries.length > 500) {
      entries.sort((left, right) => (left[1].at || 0) - (right[1].at || 0));
      for (const [stale] of entries.slice(0, entries.length - 500)) delete this.state.receipts[stale];
    }
    for (const [stale, receipt] of Object.entries(this.state.receipts)) {
      if (now - (receipt.at || 0) > 24 * 60 * 60 * 1000) delete this.state.receipts[stale];
    }
    try {
      await saveState(this.state);
    } catch (error) {
      this.logger.warn?.(`[dsh-remote] failed to persist idempotency receipt: ${error.message}`);
    }
    return response;
  }

  #handlers() {
    return {
      capabilities_get: async () => ({
        operations: [
          'capabilities.get', 'session.list', 'session.create', 'session.open',
          'session.snapshot', 'session.page', 'session.follow', 'session.unfollow',
          'agent.send', 'agent.cancel', 'agent.status', 'agent.inbox.get',
          'agent.create_or_resume', 'model.current', 'model.list', 'model.select',
        ],
        extension_namespaces: [],
        max_frame_bytes: 1024 * 1024,
        max_page_size: 200,
        content_types: ['text'],
      }),

      session_list: async (payload, { principal }) => {
        const timeout = timeoutSignal(15_000);
        const rows = await this.#controller().list({}, timeout.signal).finally(() => timeout.clear());
        const items = rows.items || [];
        const offset = this.#pageOffset(payload.page_token, principal);
        const size = Math.min(200, Math.max(1, Number(payload.page_size) || 50));
        const page = items.slice(offset, offset + size);
        const sessions = page.map((row) => {
          const sessionId = String(row.sessionId);
          return this.#summary(sessionId, row.projections?.asOfSeq, row.updatedAt, displayTitle(row), row.cwd || '');
        });
        const hasMore = offset + page.length < items.length;
        return {
          sessions,
          has_more: hasMore,
          ...(hasMore ? { next_page_token: this.#pageToken(offset + page.length, principal) } : {}),
        };
      },

      session_create: async (payload) => {
        const value = await this.#controller().create({});
        const sessionId = String(value.sessionId);
        const title = String(payload.title || '').trim();
        let appliedTitle = '';
        if (title !== '') {
          try {
            await this.#controller().rename({ sessionId, title });
            appliedTitle = title;
          } catch (error) {
            this.logger.warn?.(`[dsh-remote] native session title was not applied: ${error.message}`);
          }
        }
        let events = [];
        let workspace = '';
        try {
          const inspection = await this.#inspect(sessionId);
          events = inspection.events || [];
          workspace = inspection.meta?.cwd || '';
        } catch {
          // A just-created Session can briefly be absent from the cold reader.
        }
        const cursor = events[events.length - 1]?.seq || 0;
        return {
          baseline: this.#baseline(sessionId, events, cursor, 50, appliedTitle, workspace),
          agent: { session_id: sessionId, agent_id: sessionId, state: agentState(this.#live(sessionId)) },
        };
      },

      session_open: async (payload) => {
        const inspection = await this.#inspect(payload.session_id);
        if (payload.resume_agent) {
          try {
            await this.#controller().resolveAgent(payload.session_id);
          } catch (error) {
            throw this.#mapRemoteError(error);
          }
        }
        const events = inspection.events || [];
        const cursor = events[events.length - 1]?.seq || 0;
        return {
          baseline: this.#baseline(payload.session_id, events, cursor, 50, basename(inspection.meta?.cwd), inspection.meta?.cwd || ''),
          agent: { session_id: payload.session_id, agent_id: payload.session_id, state: agentState(this.#live(payload.session_id)) },
        };
      },

      session_snapshot: async (payload) => {
        const inspection = await this.#inspect(payload.session_id);
        const events = inspection.events || [];
        const cursor = events[events.length - 1]?.seq || 0;
        return { baseline: this.#baseline(payload.session_id, events, cursor, payload.tail_limit, basename(inspection.meta?.cwd), inspection.meta?.cwd || '') };
      },

      session_page: async (payload) => {
        const inspection = await this.#inspect(payload.session_id);
        const all = inspection.events || [];
        const size = Math.min(200, Math.max(1, Number(payload.page_size) || 50));
        let selected;
        if (payload.after_seq !== undefined) {
          selected = all.filter((event) => event.seq > payload.after_seq).slice(0, size);
        } else if (payload.before_seq !== undefined) {
          selected = all.filter((event) => event.seq < payload.before_seq).slice(-size);
        } else {
          selected = all.slice(-size);
        }
        return {
          events: selected.map((event) => mapEvent(event, undefined)),
          has_more: selected.length === size && selected[0]?.seq !== all[0]?.seq,
          committed_seq: all[all.length - 1]?.seq || 0,
        };
      },

      session_follow: async (payload, { forward }) => {
        const subscriptionId = randomUUID();
        const abort = new AbortController();
        const iterator = this.#controller().follow(
          { address: { kind: 'session', sessionId: payload.session_id }, assistantStream: true },
          abort.signal,
        )[Symbol.asyncIterator]();
        let timeoutTimer;
        let first;
        try {
          first = await Promise.race([
            iterator.next(),
            new Promise((_, reject) => {
              timeoutTimer = setTimeout(() => reject(new Error('follow snapshot timed out')), 15_000);
              timeoutTimer.unref?.();
            }),
          ]);
        } catch (error) {
          abort.abort();
          throw this.#mapRemoteError(error);
        } finally {
          clearTimeout(timeoutTimer);
        }
        if (first.done || first.value?.type !== 'snapshot') {
          abort.abort();
          throw new AdapterError('ERROR_CODE_INTERNAL', 'follow did not produce a snapshot');
        }
        const snapshot = first.value;
        const records = snapshot.records || [];
        const events = records.filter((record) => record.type === 'event').map((record) => record.event);
        const cursor = Number(snapshot.cursor || events[events.length - 1]?.seq || 0);
        const workspace = snapshot.header?.cwd || '';
        const baseline = this.#baseline(payload.session_id, events, cursor, payload.tail_limit, basename(workspace), workspace);
        const active = snapshot.assistantStream?.activeAttempt;
        if (active) {
          baseline.active_attempts = [{
            attempt_id: String(active.attemptId),
            revision: Number(active.revision || 1),
            turn_id: String(active.turn ?? ''),
            step_id: String(active.step ?? ''),
            next_chunk_index: Number(active.nextIndex || 0),
          }];
        }
        const attempts = new Map();
        if (active) attempts.set(String(active.attemptId), Number(active.nextIndex || 0));
        this.subscriptions.set(subscriptionId, {
          sessionId: payload.session_id,
          connectionId: forward.connection_id,
          abort,
          iterator,
          attempts,
        });
        setTimeout(() => this.#pumpSubscription(subscriptionId), 0);
        return { subscription_id: subscriptionId, baseline };
      },

      session_unfollow: async (payload, { forward }) => {
        const subscription = this.subscriptions.get(payload.subscription_id);
        if (subscription && forward.connection_id && subscription.connectionId !== forward.connection_id) {
          throw forbidden('subscription belongs to another connection');
        }
        this.#closeSubscription(payload.subscription_id, 'client unfollow');
        return {};
      },

      agent_send: async (payload, { principal }) => {
        this.#assertMode(payload.mode);
        const timeout = timeoutSignal(30_000);
        try {
          await this.#controller().prompt({
            requestId: String(payload.message_id),
            sessionId: payload.session_id,
            mode: payload.mode === 2 ? 'steer' : 'queue',
            content: this.#mapContentToPrompt(payload.content),
            clientTimeZone: 'UTC',
          }, timeout.signal);
        } catch (error) {
          throw this.#mapRemoteError(error);
        } finally {
          timeout.clear();
        }
        return { state: 1, inbox: { next_turn: [], next_step: [] } };
      },

      agent_cancel: async (payload, { principal }) => {
        const value = this.#controller().cancel({ sessionId: payload.session_id });
        return { cancel_requested: Boolean(value?.accepted ?? true) };
      },

      agent_status: async (payload, { principal }) => {
        const inspection = await this.#inspect(payload.session_id);
        const events = inspection.events || [];
        const cursor = events[events.length - 1]?.seq || 0;
        return {
          agent: { session_id: payload.session_id, agent_id: payload.session_id, state: agentState(this.#live(payload.session_id)) },
          projection: { schema_version: 1, data: { messages: projectionMessages(events, principal), active_turn_id: null } },
          committed_seq: cursor,
          inbox: { next_turn: [], next_step: [] },
        };
      },

      agent_inbox_get: async (payload) => {
        await this.#inspect(payload.session_id);
        return { inbox: { next_turn: [], next_step: [] } };
      },

      agent_create_or_resume: async (payload, { principal }) => {
        try {
          await this.#controller().resolveAgent(payload.session_id);
        } catch (error) {
          throw this.#mapRemoteError(error);
        }
        return {
          agent: { session_id: payload.session_id, agent_id: payload.session_id, state: agentState(this.#live(payload.session_id)) },
        };
      },

      model_current: async (payload) => {
        await this.#inspect(payload.session_id);
        const live = this.#live(payload.session_id);
        const header = live?.session?.requestHeader?.();
        const config = header?.config || live?.options;
        const modelService = typeof this.ctx.get === 'function' ? this.ctx.get('agentDefaultModel') : this.ctx.agentDefaultModel;
        const fallback = modelService?.currentSelection?.();
        const selection = config || fallback;
        if (!selection) return { selection: { provider: '', model: '' } };
        return {
          selection: {
            provider: String(selection.provider || ''),
            model: String(selection.model || ''),
            ...(selection.reasoningEffort ? { reasoning_effort: String(selection.reasoningEffort) } : {}),
          },
        };
      },

      model_list: async () => {
        const catalog = await this.#controller().modelCatalog();
        const models = [];
        for (const group of catalog.groups || []) {
          for (const model of group.models || []) {
            models.push({
              selection: { provider: group.id, model: model.id },
              capabilities: ['text'],
            });
          }
        }
        return { models };
      },

      model_select: async (payload, { principal }) => {
        const selection = payload.selection || {};
        try {
          const value = await this.#controller().selectModel({
            sessionId: payload.session_id,
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoning_effort ? { reasoningEffort: selection.reasoning_effort } : {}),
          });
          const selected = value.selected || selection;
          return {
            selection: {
              provider: String(selected.provider || ''),
              model: String(selected.model || ''),
              ...(selected.reasoningEffort ? { reasoning_effort: String(selected.reasoningEffort) } : {}),
            },
            committed_seq: 0,
          };
        } catch (error) {
          throw this.#mapRemoteError(error);
        }
      },

      approval_pending: async () => ({ requests: [] }),
      approval_decide: async () => ({ status: 4 }),
      approval_policy_get: async () => ({ policy: 1 }),
      approval_policy_set: async () => unsupported('remote approval policy changes are not implemented'),
    };
  }

  async #pumpSubscription(subscriptionId) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    const { iterator, sessionId, abort, attempts } = subscription;
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) break;
        if (value.type === 'event') {
          const event = value.event;
          const mapped = mapEvent(event, undefined);
          this.adapter.sendEvent('session_committed', {
            session_id: sessionId,
            events: [mapped],
            cursor: Number(event.seq || 0),
          }, { subscriptionId });
        } else if (value.type === 'assistant-stream') {
          this.#sendAssistantFrame(sessionId, subscriptionId, value.frame, attempts);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.adapter.sendEvent('subscription_reset', {
          subscription_id: subscriptionId,
          reason: error?.message || 'follow stream failed',
        });
      }
    } finally {
      this.subscriptions.delete(subscriptionId);
      abort.abort();
    }
  }

  #sendAssistantFrame(sessionId, subscriptionId, frame, attempts) {
    if (!frame) return;
    const attemptId = String(frame.attemptId || '');
    const revision = Number(frame.revision || 1);
    if (frame.type === 'start') {
      attempts.set(attemptId, 0);
      this.adapter.sendEvent('assistant_live_start', {
        session_id: sessionId,
        attempt: {
          attempt_id: attemptId,
          revision,
          turn_id: String(frame.turn ?? ''),
          step_id: String(frame.step ?? ''),
          next_chunk_index: 0,
        },
      }, { subscriptionId });
      return;
    }
    if (frame.type === 'chunk') {
      const chunk = frame.chunk || {};
      let content;
      if (chunk.type === 'text-delta') content = { text: String(chunk.text || '') };
      else if (chunk.type === 'reasoning-delta') content = { reasoning: String(chunk.text || '') };
      else if (chunk.type === 'tool-call-delta') content = {
        tool_call: {
          call_id: String(chunk.id || ''),
          tool_name: String(chunk.name || ''),
          arguments: {},
        },
      };
      if (!content) return;
      const index = attempts.get(attemptId) ?? Number(frame.index || 0);
      attempts.set(attemptId, index + 1);
      this.adapter.sendEvent('assistant_live_chunk', {
        session_id: sessionId,
        attempt_id: attemptId,
        revision,
        chunks: [{ chunk_index: index, content }],
      }, { subscriptionId });
      return;
    }
    if (frame.type === 'end') {
      attempts.delete(attemptId);
      const outcome = frame.outcome?.kind;
      const map = { committed: 1, abandoned: 2, failed: 3, cancelled: 4 };
      if (!map[outcome]) return;
      this.adapter.sendEvent('assistant_live_end', {
        session_id: sessionId,
        attempt_id: attemptId,
        revision,
        outcome: map[outcome],
        ...(outcome === 'committed' ? { committed_seq: Number(frame.outcome.seq || 0) } : {}),
      }, { subscriptionId });
    }
  }

  #closeSubscription(subscriptionId, reason) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    this.subscriptions.delete(subscriptionId);
    subscription.abort.abort(reason);
  }

  closeConnection(connectionId) {
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.connectionId === connectionId) {
        this.subscriptions.delete(id);
        subscription.abort.abort('mobile connection closed');
      }
    }
  }

  closeAll(reason) {
    for (const [id, subscription] of this.subscriptions) {
      this.subscriptions.delete(id);
      subscription.abort.abort(reason);
    }
  }
}
