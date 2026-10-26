/* Manual integration harness: connects to a local relay and prints a pairing code. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState } from '../lib/identity.js';
import { RelayHarness } from '../lib/adapter.js';

if (!process.env.DSH_REMOTE_STATE) {
  process.env.DSH_REMOTE_STATE = join(mkdtempSync(join(tmpdir(), 'dsh-remote-adapter-')), 'state.json');
}
const base = process.env.HRP_TEST_URL || 'ws://127.0.0.1:53215';
const token = process.env.HRP_TEST_TOKEN || '';
const state = await loadState();
state.relayUrl = base;
if (token) state.registrationToken = token;
state.displayName = 'Node Test Harness';

const adapter = new RelayHarness({
  state,
  handlers: {
    capabilities_get: async () => ({
      operations: ['capabilities.get', 'session.list'],
      extension_namespaces: [],
      max_frame_bytes: 1048576,
      max_page_size: 200,
      content_types: ['text'],
    }),
    session_list: async () => ({ sessions: [], has_more: false }),
  },
});
adapter.on('status', (status) => {
  if (!status.ready && !status.lastError) return;
  console.log('STATUS', status.state, status.aclVersion, status.members.length, status.lastError);
});
adapter.on('online', async () => {
  console.log('ONLINE', adapter.status().harnessId);
  try {
    const pair = await adapter.pairCreate();
    console.log('PAIR', pair.code, pair.expiresAt);
  } catch (error) {
    console.error('PAIR_ERR', error.code, error.message);
  }
});
adapter.on('membership', (membership) => {
  console.log('MEMBERSHIP', membership.aclVersion, membership.members.map((m) => `${m.userId}:${m.deviceId}`).join(','));
});
await adapter.connect();
setTimeout(async () => {
  console.log('FINAL', JSON.stringify(adapter.status()));
  await adapter.disconnect();
  process.exit(0);
}, Number(process.env.HRP_TEST_MS || 45000));
