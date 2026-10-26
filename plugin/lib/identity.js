import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STATE_VERSION = 1;

export function statePath() {
  if (process.env.DSH_REMOTE_STATE) return process.env.DSH_REMOTE_STATE;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-remote', 'state.json');
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    relayUrl: process.env.DSH_REMOTE_URL || 'ws://127.0.0.1:53214',
    registrationToken: process.env.DSH_REMOTE_REGISTRATION_TOKEN || '',
    harnessId: '',
    displayName: 'DeepSeek Harness',
    privateKey: '',
    publicKey: '',
    createdAt: 0,
    registered: false,
    remoteSessions: {},
    receipts: {},
  };
}

function normalize(raw) {
  const fallback = defaultState();
  const state = {
    ...fallback,
    ...(raw && typeof raw === 'object' ? raw : {}),
  };
  if (!state.harnessId) state.harnessId = crypto.randomUUID();
  if (!state.privateKey || !state.publicKey) {
    const identity = generateIdentity();
    state.privateKey = identity.privateKey;
    state.publicKey = identity.publicKey;
  }
  if (!state.createdAt) state.createdAt = Date.now();
  state.registered = state.registered === true;
  if (!state.remoteSessions || typeof state.remoteSessions !== 'object') state.remoteSessions = {};
  if (!state.receipts || typeof state.receipts !== 'object') state.receipts = {};
  return state;
}

export async function loadState() {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8'));
    return normalize(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return normalize({});
  }
}

export async function saveState(state) {
  const file = statePath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    publicKey: Buffer.from(spki.subarray(spki.length - 32)).toString('base64'),
    privateKey: Buffer.from(pkcs8).toString('base64'),
  };
}

export function publicKeyBytes(state) {
  return Buffer.from(state.publicKey, 'base64');
}

export function signState(state, message) {
  const key = createPrivateKey({
    key: Buffer.from(state.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return cryptoSign(null, message, key);
}

export function verifyPublicKey(state) {
  try {
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const key = createPublicKey({
      key: Buffer.concat([spkiPrefix, publicKeyBytes(state)]),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/** Length-prefixed transcript shared by auth and pairing proofs. */
export function transcript(prefix, parts) {
  const buffers = parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part)));
  const out = [Buffer.from(prefix, 'utf8')];
  for (const part of buffers) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(part.length, 0);
    out.push(length, part);
  }
  return Buffer.concat(out);
}

export function authTranscript(relayId, harnessId, challengeId, nonce) {
  return transcript('HRP-AUTH-v1', [relayId, harnessId, 'harness', challengeId, nonce]);
}
