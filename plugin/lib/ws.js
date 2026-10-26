/**
 * Dependency-free RFC 6455 WebSocket client.
 *
 * The HRP Harness endpoint requires an Authorization header on the upgrade
 * request, which the WHATWG WebSocket API cannot express. This client supports
 * the small binary-only subset the relay speaks: masking, fragmentation,
 * ping/pong, close frames and TLS certificate verification.
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

const MAX_FRAME = 1024 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload, mask = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, body]);
  header[1] |= 0x80;
  const key = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) masked[i] = body[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

export class HrpWebSocket extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.closed = false;
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentBytes = 0;
    this.lastMessageAt = Date.now();
    socket.on('data', (chunk) => this.#receive(chunk));
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#finish());
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastMessageAt > 60_000) {
        this.close(1001, 'idle timeout');
        return;
      }
      try {
        this.socket.write(frame(0x9, Buffer.alloc(0)));
      } catch {
        // The close path owns cleanup.
      }
    }, 20_000);
    this.heartbeat.unref?.();
    if (this.buffer.length) queueMicrotask(() => this.#drain());
  }

  get open() {
    return !this.closed;
  }

  sendBinary(payload) {
    if (this.closed) throw new Error('websocket is closed');
    if (payload.length > MAX_FRAME) throw new Error('websocket frame exceeds 1 MiB');
    this.socket.write(frame(0x2, payload));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    try {
      const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      this.socket.write(frame(0x8, payload));
    } catch {
      // Fall through to teardown.
    }
    this.closed = true;
    clearInterval(this.heartbeat);
    const socket = this.socket;
    setTimeout(() => socket.destroy(), 1000).unref?.();
    socket.end();
    this.emit('close', { code, reason, clean: true });
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.emit('error', error);
    this.#finish();
  }

  #finish() {
    if (!this.closed) {
      this.closed = true;
      clearInterval(this.heartbeat);
      this.emit('close', { code: 1006, reason: 'socket closed', clean: false });
    }
  }

  #receive(chunk) {
    this.lastMessageAt = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.#drain();
  }

  #drain() {
    while (!this.closed && this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (rsv !== 0) {
        this.close(1002, 'reserved bits');
        return;
      }
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) {
          this.close(1009, 'frame too large');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_FRAME) {
        this.close(1009, 'frame too large');
        return;
      }
      let maskKey;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const copy = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) copy[i] = payload[i] ^ maskKey[i & 3];
        payload = copy;
      }
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.close(code === 1005 ? 1000 : code, reason);
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1) {
        this.close(1003, 'text frames are not supported');
        return;
      }
      if (opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          this.fragmentOpcode = opcode;
          this.fragments = [];
          this.fragmentBytes = 0;
        } else if (this.fragmentOpcode !== 0x2) {
          this.close(1002, 'unexpected continuation');
          return;
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_FRAME) {
          this.close(1009, 'message too large');
          return;
        }
        if (fin) {
          const message = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentOpcode = 0;
          this.fragmentBytes = 0;
          this.emit('message', message);
        }
        continue;
      }
      this.close(1002, `unsupported opcode ${opcode}`);
      return;
    }
  }
}

function parseUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('relay URL must start with ws:// or wss://');
  }
  return url;
}

/** Open one HRP relay WebSocket and resolve after a successful upgrade. */
export function openWebSocket(rawUrl, { headers = {}, subprotocol = 'hrp.relay.pb.v1', signal } = {}) {
  const url = parseUrl(rawUrl);
  const secure = url.protocol === 'wss:';
  const port = Number(url.port || (secure ? 443 : 80));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const key = randomBytes(16).toString('base64');
  const requestTarget = `${url.pathname || '/'}${url.search}`;
  const lines = [
    `GET ${requestTarget} HTTP/1.1`,
    `Host: ${url.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Protocol: ${subprotocol}`,
    ...Object.entries(headers)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ];
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('websocket upgrade timed out'));
    }, 10_000);
    timer.unref?.();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error('websocket upgrade aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      socket.off('data', onData);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 64 * 1024) onError(new Error('websocket upgrade response too large'));
        return;
      }
      const headerText = head.subarray(0, end).toString('latin1');
      const statusLine = headerText.split('\r\n')[0] || '';
      const match = /^HTTP\/1\.1 (\d{3})/.exec(statusLine);
      if (!match) {
        onError(new Error(`invalid websocket upgrade response: ${statusLine}`));
        return;
      }
      const status = Number(match[1]);
      const responseHeaders = new Map();
      for (const line of headerText.split('\r\n').slice(1)) {
        const index = line.indexOf(':');
        if (index > 0) responseHeaders.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
      }
      const accept = responseHeaders.get('sec-websocket-accept');
      const expected = createHash('sha1').update(`${key}${GUID}`).digest('base64');
      if (status !== 101) {
        const body = head.subarray(end + 4).toString('utf8').slice(0, 200);
        onError(new Error(`relay rejected websocket upgrade: HTTP ${status}${body ? ` ${body}` : ''}`));
        return;
      }
      if (accept !== expected) {
        onError(new Error('relay websocket accept key did not match'));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(new HrpWebSocket(socket, head.subarray(end + 4)));
    };
    socket.on('error', onError);
    socket.on('data', onData);
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(lines.join('\r\n')));
  });
}
