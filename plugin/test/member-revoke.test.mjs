import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayHarness } from '../lib/adapter.js';

function adapterFor() {
  const state = {
    relayUrl: 'ws://127.0.0.1:1',
    registrationToken: '',
    harnessId: 'harness-1',
    displayName: 'Test Harness',
    publicKey: '',
    privateKey: '',
    registered: true,
    receipts: {},
  };
  const adapter = new RelayHarness({ state });
  adapter.ready = true;
  return adapter;
}

test('revokeMember sends a harness-scoped mutation with the device id', async () => {
  const adapter = adapterFor();
  let captured;
  adapter.rpc = async (operation, payload) => {
    captured = { operation, payload };
    return { acl_version: 2, removed: true };
  };
  const result = await adapter.revokeMember('device-1');
  assert.deepEqual(result, { acl_version: 2, removed: true });
  assert.equal(captured.operation, 'member_revoke');
  assert.equal(captured.payload.harness_id, 'harness-1');
  assert.equal(captured.payload.device_id, 'device-1');
  assert.equal(typeof captured.payload.mutation.client_operation_id, 'string');
  assert.ok(captured.payload.mutation.client_operation_id.length > 0);
});

test('revokeMember rejects an empty device id before the relay call', async () => {
  const adapter = adapterFor();
  await assert.rejects(adapter.revokeMember('  '), (error) => error.code === 'ERROR_CODE_INVALID_ARGUMENT');
});

test('revokeMember requires an online relay', async () => {
  const adapter = adapterFor();
  adapter.ready = false;
  await assert.rejects(adapter.revokeMember('device-1'), (error) => error.code === 'ERROR_CODE_HARNESS_OFFLINE');
});
