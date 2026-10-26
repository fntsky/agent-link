import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, oneof } from '../lib/proto.js';

const fixtures = {
  auth: 'CAESBXJlcS0xIgNoLTFSCVIHCgNoLTEQAg==',
  sync: 'CAESBXJlcS0yGgVyZXEtMSIDaC0xWgR6AggH',
  agent_send: 'CAESBXJlcS0zIgNoLTFSTcoBShIDcy0xGgNtLTEiBwoFaGVsbG8iMxoxCgFjEgRiYXNoGiYKDgoBYRIJEQAAAAAAAPA/ChQKAWISDzINCgIgAQoCCAAKAxoBeCgB',
};

test('auth.challenge fixture decodes and round-trips', () => {
  const bytes = Buffer.from(fixtures.auth, 'base64');
  const value = decode('hrp.v1.Envelope', bytes);
  assert.equal(value.version, 1);
  assert.equal(oneof('hrp.v1.Request', value.request, 'operation'), 'auth_challenge');
  assert.equal(value.request.auth_challenge.peer_kind, 2);
  assert.deepEqual(encode('hrp.v1.Envelope', value), bytes);
});

test('membership acknowledgement fixture round-trips', () => {
  const bytes = Buffer.from(fixtures.sync, 'base64');
  const value = decode('hrp.v1.Envelope', bytes);
  assert.equal(value.reply_to, 'req-1');
  assert.equal(value.response.membership_snapshot.applied_acl_version, 7);
  assert.deepEqual(encode('hrp.v1.Envelope', value), bytes);
});

test('nested Struct and bytes fields round-trip', () => {
  const bytes = Buffer.from(fixtures.agent_send, 'base64');
  const value = decode('hrp.v1.Envelope', bytes);
  const send = value.request.agent_send;
  assert.equal(send.content[0].text, 'hello');
  assert.equal(send.content[1].tool_call.tool_name, 'bash');
  assert.deepEqual(send.content[1].tool_call.arguments, { a: 1, b: [true, null, 'x'] });
  assert.deepEqual(encode('hrp.v1.Envelope', value), bytes);
});
