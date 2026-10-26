/**
 * Host half of the DSH Remote plugin: maintains the HRP v1 Harness connection
 * to a relay, answers its RPC surface from DSH Sessions, and serves the
 * package-private settings RPC consumed by the Client half.
 */
import { AdapterError, RelayHarness } from './lib/adapter.js';
import { loadState, saveState, statePath } from './lib/identity.js';
import { SessionBridge } from './lib/sessions.js';

export const name = 'dsh-remote';
export const inject = ['connection', 'webServer', 'sessionController', 'agents'];

const CHANNEL = '/dsh-remote';
const MAX_BODY = 64 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        request.pause();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function endpointOf(pathname) {
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined;
  const endpoint = pathname.slice(CHANNEL.length + 1);
  if (!endpoint || endpoint.split('/').some((part) => part === '' || part === '.' || part === '..' || !/^[A-Za-z0-9_$.-]+$/.test(part))) {
    return undefined;
  }
  return endpoint;
}

function settingsRoute(connection, dispatch) {
  return {
    kind: 'prefix',
    path: CHANNEL,
    handler: async (request, response) => {
      const rejection = connection.requestRejection(request);
      if (rejection !== undefined) {
        response.writeHead(rejection);
        response.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(404);
        response.end();
        return;
      }
      const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        response.writeHead(415);
        response.end('content type must be application/json');
        return;
      }
      const endpoint = endpointOf(new URL(request.url || '/', 'http://dsh.internal').pathname);
      if (!endpoint) {
        response.writeHead(404);
        response.end();
        return;
      }
      let message;
      try {
        message = JSON.parse(await readBody(request));
      } catch (error) {
        response.writeHead(error.message === 'request body too large' ? 413 : 400);
        response.end();
        return;
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
      if (message?.type !== 'client-request' || typeof message?.method !== 'string') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId,
          result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } },
        }));
        return;
      }
      if (message.method !== endpoint) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} },
          },
        }));
        return;
      }
      let result;
      try {
        const value = await dispatch(endpoint, message.payload ?? {});
        result = { ok: true, value };
      } catch (error) {
        result = {
          ok: false,
          error: {
            code: error instanceof AdapterError ? error.code : 'dsh-remote/internal',
            message: error?.message || String(error),
            details: {},
          },
        };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId, result }));
    },
  };
}

export async function apply(ctx) {
  const logger = ctx.logger ?? console;
  const state = await loadState();
  await saveState(state);
  const adapter = new RelayHarness({ state, logger, handlers: {} });
  const bridge = new SessionBridge({ ctx, adapter, state, logger });
  adapter.handlers = bridge.handlers;

  async function dispatch(endpoint, payload) {
    switch (endpoint) {
      case 'status':
        return adapter.status();
      case 'config':
        return {
          relayUrl: state.relayUrl,
          displayName: state.displayName,
          harnessId: state.harnessId,
          tokenConfigured: Boolean(state.registrationToken),
          statePath: statePath(),
        };
      case 'configure':
        return adapter.updateConfig({
          ...(typeof payload.relayUrl === 'string' ? { relayUrl: payload.relayUrl } : {}),
          ...(typeof payload.registrationToken === 'string' ? { registrationToken: payload.registrationToken } : {}),
          ...(typeof payload.displayName === 'string' ? { displayName: payload.displayName } : {}),
        });
      case 'connect':
        await adapter.connect();
        return adapter.status();
      case 'disconnect':
        await adapter.disconnect();
        return adapter.status();
      case 'pair.create':
        return adapter.pairCreate();
      case 'pair.clear':
        adapter.clearPairing();
        return adapter.status();
      case 'identity.info':
        return {
          harnessId: state.harnessId,
          publicKey: state.publicKey,
          registered: state.registered,
          statePath: statePath(),
        };
      default:
        throw new AdapterError('dsh-remote/unknown-method', `unknown settings method: ${endpoint}`);
    }
  }

  ctx.effect(() => ctx.webServer.register(settingsRoute(ctx.connection, dispatch)), 'dsh-remote: settings RPC');
  ctx.effect(() => () => {
    bridge.closeAll('plugin unloaded');
    void adapter.disconnect();
  }, 'dsh-remote: relay lifecycle');

  if (state.registrationToken || state.registered) {
    adapter.connect().catch((error) => {
      logger.warn?.(`[dsh-remote] initial relay connection failed: ${error.message}`);
    });
  }
}
