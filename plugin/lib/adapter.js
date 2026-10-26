import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { encode, decode, oneof, enumName, enums } from './proto.js';
import { openWebSocket } from './ws.js';
import { authTranscript, saveState, signState, publicKeyBytes } from './identity.js';

const ADAPTER_VERSION = 'dsh-remote/0.1.0';
const REQUEST_TIMEOUT = 30_000;
const HANDSHAKE_TIMEOUT = 20_000;

export class AdapterError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export function unsupported(message = 'operation is not supported by this Harness adapter') {
  return new AdapterError('ERROR_CODE_UNSUPPORTED_OPERATION', message);
}

export function invalid(message) {
  return new AdapterError('ERROR_CODE_INVALID_ARGUMENT', message);
}

export function forbidden(message = 'not authorized for this operation') {
  return new AdapterError('ERROR_CODE_FORBIDDEN', message);
}

function errorNumber(code) {
  return enums['hrp.v1.ErrorCode']?.[code] ?? 13;
}

function roleNames(roles) {
  return (roles || []).map((role) => enumName('hrp.v1.MemberRole', role));
}

export class RelayHarness extends EventEmitter {
  constructor({ state, logger = console, handlers = {} }) {
    super();
    this.state = state;
    this.logger = logger;
    this.handlers = handlers;
    this.ws = null;
    this.ready = false;
    this.authenticated = false;
    this.synced = false;
    this.wantConnection = false;
    this.fatal = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pending = new Map();
    this.members = new Map();
    this.aclVersion = 0;
    this.onlineSince = 0;
    this.lastError = '';
    this.pairing = null;
    this.syncWaiters = [];
    this.statusListeners = new Set();
    this.connectionId = '';
  }

  status() {
    const now = Date.now();
    if (this.pairing && this.pairing.expiresAt <= now) this.pairing = null;
    return {
      state: this.ready ? 'online' : this.wantConnection ? (this.ws ? 'handshaking' : 'connecting') : 'disconnected',
      ready: this.ready,
      relayUrl: this.state.relayUrl,
      harnessId: this.state.harnessId,
      displayName: this.state.displayName,
      aclVersion: this.aclVersion,
      onlineSince: this.onlineSince || null,
      lastError: this.lastError,
      tokenConfigured: Boolean(this.state.registrationToken),
      adapterVersion: ADAPTER_VERSION,
      members: [...this.members.values()].map((member) => ({
        deviceId: member.device_id,
        userId: member.user_id,
        roles: roleNames(member.roles),
      })),
      pairing: this.pairing
        ? {
            code: this.pairing.code,
            pairingId: this.pairing.pairingId,
            expiresAt: this.pairing.expiresAt,
          }
        : null,
    };
  }

  subscribeStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  #publish() {
    const snapshot = this.status();
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch {
        // Status listeners are UI/telemetry only.
      }
    }
    this.emit('status', snapshot);
  }

  async updateConfig(patch) {
    let changed = false;
    if (typeof patch.relayUrl === 'string') {
      let parsed;
      try {
        parsed = new URL(patch.relayUrl);
      } catch {
        throw invalid('远程地址不是合法 URL');
      }
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        throw invalid('远程地址必须以 ws:// 或 wss:// 开头');
      }
      if (patch.relayUrl !== this.state.relayUrl) {
        this.state.relayUrl = patch.relayUrl.replace(/\/+$/, '');
        changed = true;
      }
    }
    if (typeof patch.registrationToken === 'string') {
      const token = patch.registrationToken.trim();
      if (token && token.length < 32) throw invalid('注册令牌至少需要 32 个字符');
      if (token !== this.state.registrationToken) {
        this.state.registrationToken = token;
        changed = true;
      }
    }
    if (typeof patch.displayName === 'string') {
      const name = patch.displayName.trim();
      if (!name || name.length > 256) throw invalid('显示名称长度必须为 1–256 个字符');
      if (name !== this.state.displayName) {
        this.state.displayName = name;
        changed = true;
      }
    }
    if (changed) {
      await saveState(this.state);
      if (this.wantConnection) {
        this.disconnect();
        await this.connect();
      } else {
        this.#publish();
      }
    }
    return this.status();
  }

  async connect(isRetry = false) {
    if (this.ws) return;
    this.wantConnection = true;
    this.fatal = false;
    this.lastError = '';
    if (!isRetry) this.reconnectAttempt = 0;
    this.#publish();
    try {
      await this.#open();
    } catch (error) {
      this.lastError = error.message;
      this.#publish();
      if (!this.fatal) this.#scheduleReconnect();
    }
    return this.status();
  }

  async disconnect() {
    this.wantConnection = false;
    this.fatal = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ready = false;
    this.authenticated = false;
    this.synced = false;
    this.#rejectPending(new AdapterError('ERROR_CODE_HARNESS_OFFLINE', 'relay connection closed'));
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners('close');
      ws.on('close', () => {});
      ws.close(1000, 'client disconnect');
    }
    this.#publish();
  }

  #harnessUrl() {
    const url = new URL(this.state.relayUrl);
    const path = url.pathname.replace(/\/+$/, '');
    if (!path || path === '') url.pathname = '/ws/harness';
    else if (!path.endsWith('/ws/harness')) url.pathname = `${path}/ws/harness`;
    return url.toString();
  }

  async #open() {
    const ws = await openWebSocket(this.#harnessUrl(), {
      headers: this.state.registrationToken
        ? { Authorization: `Bearer ${this.state.registrationToken}` }
        : {},
    });
    this.ws = ws;
    ws.on('message', (data) => this.#onFrame(data));
    ws.on('error', (error) => {
      this.lastError = error.message;
      this.logger.warn?.(`[dsh-remote] websocket error: ${error.message}`);
    });
    ws.on('close', (info) => this.#onClose(info));
    this.#publish();
    try {
      await this.#handshake();
    } catch (error) {
      this.lastError = error.message;
      this.fatal = true;
      this.ready = false;
      this.authenticated = false;
      this.logger.warn?.(`[dsh-remote] handshake failed: ${error.message}`);
      ws.removeAllListeners('close');
      ws.on('close', () => {});
      ws.close(1000, 'handshake failed');
      this.ws = null;
      this.#publish();
      throw error;
    }
  }

  async #handshake() {
    if (this.state.registrationToken) {
      try {
        await this.#rpc('harness_register', {
          harness_id: this.state.harnessId,
          public_key: publicKeyBytes(this.state),
          display_name: this.state.displayName,
        }, 10_000);
      } catch (error) {
        if (error.code !== 'ERROR_CODE_FORBIDDEN') throw error;
        this.logger.info?.('[dsh-remote] harness already registered; continuing to proof');
      }
    }
    const challenge = await this.#rpc('auth_challenge', {
      identity_id: this.state.harnessId,
      peer_kind: 2,
    }, 10_000);
    const relayId = challenge.relay_id;
    const signature = signState(
      this.state,
      authTranscript(relayId, this.state.harnessId, challenge.challenge_id, challenge.nonce),
    );
    await this.#rpc('auth_prove', { challenge_id: challenge.challenge_id, signature }, 10_000);
    this.authenticated = true;
    this.#publish();
    if (this.synced) return this.#finishHandshake();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.syncWaiters.indexOf(waiter);
        if (index >= 0) this.syncWaiters.splice(index, 1);
        reject(new Error('timed out waiting for membership snapshot'));
      }, HANDSHAKE_TIMEOUT);
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.syncWaiters.push(waiter);
    });
    return this.#finishHandshake();
  }

  async #finishHandshake() {
    this.ready = true;
    this.state.registered = true;
    await saveState(this.state);
    this.onlineSince = Date.now();
    this.reconnectAttempt = 0;
    this.lastError = '';
    this.#publish();
    this.emit('online', this.status());
  }

  async rpc(operation, payload, timeout = REQUEST_TIMEOUT) {
    if (!this.ready) throw new AdapterError('ERROR_CODE_HARNESS_OFFLINE', 'Harness relay connection is not online');
    return this.#rpc(operation, payload, timeout);
  }

  async pairCreate() {
    if (!this.ready) throw new AdapterError('ERROR_CODE_HARNESS_OFFLINE', '暂时无法配对：Harness 尚未连接 Relay');
    const response = await this.rpc('pair_create', {
      mutation: { client_operation_id: randomUUID() },
      harness_id: this.state.harnessId,
      mode: 1,
    });
    this.pairing = {
      code: response.pairing_code,
      pairingId: response.pairing_id,
      expiresAt: (response.expires_at?.seconds || 0) * 1000,
    };
    this.#publish();
    return this.pairing;
  }

  clearPairing() {
    this.pairing = null;
    this.#publish();
  }

  sendEvent(operation, payload, { subscriptionId = '', routeId = '' } = {}) {
    if (!this.ws?.open) return false;
    const envelope = {
      version: 1,
      request_id: randomUUID(),
      harness_id: this.state.harnessId,
      event: { [operation]: payload },
    };
    if (subscriptionId) envelope.subscription_id = subscriptionId;
    this.#sendForward(envelope, routeId);
    return true;
  }

  #sendForward(envelope, routeId) {
    if (!this.ws?.open) throw new Error('websocket is closed');
    const frame = encode('hrp.v1.HarnessForward', { route_id: routeId || '', envelope });
    this.ws.sendBinary(frame);
  }

  #rpc(operation, payload, timeout) {
    const requestId = randomUUID();
    const envelope = {
      version: 1,
      request_id: requestId,
      harness_id: this.state.harnessId,
      request: { [operation]: payload || {} },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AdapterError('ERROR_CODE_SUBSCRIPTION_RESET_REQUIRED', `${operation} timed out`));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer, operation });
      try {
        this.#sendForward(envelope, '');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  #rejectPending(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  #onFrame(data) {
    let forward;
    try {
      forward = decode('hrp.v1.RelayForward', data);
    } catch (error) {
      this.lastError = `invalid RelayForward: ${error.message}`;
      this.logger.warn?.(`[dsh-remote] ${this.lastError}`);
      return;
    }
    const envelope = forward.envelope;
    if (!envelope) return;
    if (envelope.reply_to && this.pending.has(envelope.reply_to)) {
      const entry = this.pending.get(envelope.reply_to);
      this.pending.delete(envelope.reply_to);
      clearTimeout(entry.timer);
      if (envelope.error) {
        entry.reject(new AdapterError(
          enumName('hrp.v1.ErrorCode', envelope.error.code),
          envelope.error.message || 'relay rejected request',
        ));
      } else if (envelope.response) {
        const operation = oneof('hrp.v1.Response', envelope.response, 'operation');
        if (!operation) {
          entry.reject(new AdapterError('ERROR_CODE_INVALID_ARGUMENT', 'relay response has no operation'));
        } else if (operation !== entry.operation) {
          entry.reject(new AdapterError('ERROR_CODE_INVALID_ARGUMENT', `relay response ${operation} does not match request ${entry.operation}`));
        } else {
          entry.resolve(envelope.response[operation] || {});
        }
      } else {
        entry.reject(new AdapterError('ERROR_CODE_INVALID_ARGUMENT', 'relay reply has no response body'));
      }
      return;
    }
    if (envelope.event) {
      this.#onEvent(envelope.event, forward);
      return;
    }
    if (envelope.request) {
      this.#onRequest(envelope, forward);
      return;
    }
    if (envelope.error) {
      this.lastError = `${envelope.error.message || 'relay error'} (${enumName('hrp.v1.ErrorCode', envelope.error.code)})`;
      this.#publish();
    }
  }

  #onEvent(event, forward) {
    const operation = oneof('hrp.v1.Event', event, 'operation');
    if (!operation) return;
    if (operation === 'relay_connection_closed') {
      const connectionId = event.relay_connection_closed?.connection_id || forward.connection_id;
      this.emit('connection-closed', connectionId);
      return;
    }
    this.emit('event', { operation, payload: event[operation], forward });
  }

  #onRequest(envelope, forward) {
    const request = envelope.request;
    const operation = oneof('hrp.v1.Request', request, 'operation');
    if (!operation) {
      this.#replyError(envelope, forward.route_id, 'ERROR_CODE_UNSUPPORTED_OPERATION', 'missing request operation');
      return;
    }
    if (operation === 'membership_snapshot') {
      this.#applySnapshot(request.membership_snapshot || {}, envelope, forward.route_id);
      return;
    }
    this.#dispatchBusiness(operation, request[operation] || {}, envelope, forward).catch((error) => {
      this.#replyError(envelope, forward.route_id, 'ERROR_CODE_INTERNAL', error.message);
    });
  }

  #applySnapshot(snapshot, envelope, routeId) {
    const version = Number(snapshot.acl_version || 0);
    if (version < this.aclVersion) {
      this.#replyError(envelope, routeId, 'ERROR_CODE_ACL_NOT_SYNCED', 'membership snapshot moved backwards');
      return;
    }
    this.aclVersion = version;
    this.synced = true;
    const previousMembers = this.members.size;
    this.members = new Map((snapshot.members || []).map((member) => [member.device_id, member]));
    if (this.pairing && this.members.size > previousMembers) this.pairing = null;
    const response = {
      version: 1,
      request_id: randomUUID(),
      reply_to: envelope.request_id,
      harness_id: this.state.harnessId,
      response: { membership_snapshot: { applied_acl_version: version } },
    };
    try {
      this.#sendForward(response, routeId);
    } catch (error) {
      this.lastError = error.message;
    }
    for (const waiter of this.syncWaiters.splice(0)) waiter.resolve();
    this.#publish();
    this.emit('membership', { aclVersion: version, members: this.status().members });
  }

  async #dispatchBusiness(operation, payload, envelope, forward) {
    if (!this.ready) {
      this.#replyError(envelope, forward.route_id, 'ERROR_CODE_ACL_NOT_SYNCED', 'membership is not synchronized');
      return;
    }
    if (!forward.route_id) {
      this.#replyError(envelope, forward.route_id, 'ERROR_CODE_INVALID_ARGUMENT', 'business request has no route');
      return;
    }
    const principal = forward.principal;
    if (!principal || !principal.device_id || !principal.user_id) {
      this.#replyError(envelope, forward.route_id, 'ERROR_CODE_UNAUTHENTICATED', 'missing relaying principal');
      return;
    }
    const member = this.members.get(principal.device_id);
    if (!member || member.user_id !== principal.user_id) {
      this.#replyError(envelope, forward.route_id, 'ERROR_CODE_FORBIDDEN', 'principal is not a current member');
      return;
    }
    if (Number(principal.acl_version) !== this.aclVersion) {
      this.#replyError(envelope, forward.route_id, 'ERROR_CODE_ACL_NOT_SYNCED', 'principal ACL version is stale');
      return;
    }
    if (!this.handlers[operation]) {
      this.#replyError(envelope, forward.route_id, 'ERROR_CODE_UNSUPPORTED_OPERATION', `${operation} is not implemented`);
      return;
    }
    try {
      const result = await this.handlers[operation](payload, { principal, forward, adapter: this });
      if (result === undefined) {
        this.#replyError(envelope, forward.route_id, 'ERROR_CODE_INTERNAL', 'handler returned no response');
        return;
      }
      const response = {
        version: 1,
        request_id: randomUUID(),
        reply_to: envelope.request_id,
        harness_id: this.state.harnessId,
        response: { [operation]: result },
      };
      this.#sendForward(response, forward.route_id);
    } catch (error) {
      const code = error instanceof AdapterError ? error.code : 'ERROR_CODE_INTERNAL';
      this.#replyError(envelope, forward.route_id, code, error.message);
    }
  }

  #replyError(envelope, routeId, code, message) {
    const response = {
      version: 1,
      request_id: randomUUID(),
      reply_to: envelope.request_id,
      harness_id: this.state.harnessId,
      error: {
        code: errorNumber(code),
        message: String(message || code).slice(0, 512),
        retryable: code === 'ERROR_CODE_HARNESS_OFFLINE' || code === 'ERROR_CODE_ACL_NOT_SYNCED',
      },
    };
    try {
      this.#sendForward(response, routeId);
    } catch (error) {
      this.logger.warn?.(`[dsh-remote] failed to send error reply: ${error.message}`);
    }
  }

  #onClose(info) {
    const wasReady = this.ready;
    this.ws = null;
    this.ready = false;
    this.authenticated = false;
    this.synced = false;
    this.#rejectPending(new AdapterError('ERROR_CODE_HARNESS_OFFLINE', 'relay connection closed'));
    if (wasReady) this.emit('offline', info);
    if (!this.wantConnection) {
      this.#publish();
      return;
    }
    if (this.fatal) {
      this.#publish();
      return;
    }
    this.lastError = info?.clean ? '' : info?.reason || 'relay connection closed';
    this.#publish();
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (!this.wantConnection || this.fatal || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantConnection) return;
      this.connect(true).catch(() => {});
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
