/**
 * Minimal schema-driven Protocol Buffers codec for the HRP v1 contract.
 *
 * The wire schema is generated from proto/hrp/v1/hrp.proto into schema.json.
 * No runtime dependency is required; unknown fields are skipped as proto3
 * requires, and unsigned 64-bit values are carried as JS numbers because every
 * HRP counter, sequence and timestamp is far below Number.MAX_SAFE_INTEGER.
 */
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));

const WIRE_VARINT = new Set([
  'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool', 'enum',
]);
const WIRE_64 = new Set(['fixed64', 'sfixed64', 'double']);
const WIRE_32 = new Set(['fixed32', 'sfixed32', 'float']);

function messageType(name) {
  const type = schema.messages[name];
  if (!type) throw new Error(`unknown protobuf message type: ${name}`);
  return type;
}

function enumNumber(name, value) {
  const values = schema.enums[name];
  if (!values) throw new Error(`unknown protobuf enum type: ${name}`);
  if (typeof value === 'number') return value;
  if (!Object.hasOwn(values, value)) throw new Error(`unknown ${name} value: ${value}`);
  return values[value];
}

function encodeVarint(value) {
  let n = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (n < 0n) n = BigInt.asUintN(64, n);
  const out = [];
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (offset + i >= buf.length) throw new Error('truncated varint');
    const byte = buf[offset + i];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [result, offset + i + 1];
    }
    shift += 7n;
  }
  throw new Error('varint longer than 10 bytes');
}

function asNumber(n) {
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n);
  return n;
}

function tag(fieldNumber, wireType) {
  return encodeVarint(BigInt(fieldNumber) * 8n + BigInt(wireType));
}

function encodeScalar(type, typeName, value) {
  if (type === 'enum') return encodeVarint(enumNumber(typeName, value));
  if (type === 'bool') return encodeVarint(value ? 1 : 0);
  if (type === 'string') return Buffer.from(String(value), 'utf8');
  if (type === 'bytes') return Buffer.from(value);
  if (type === 'double') {
    const b = Buffer.allocUnsafe(8);
    b.writeDoubleLE(Number(value), 0);
    return b;
  }
  if (type === 'float') {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatLE(Number(value), 0);
    return b;
  }
  if (type === 'fixed64' || type === 'sfixed64') {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), 0);
    return b;
  }
  if (type === 'fixed32' || type === 'sfixed32') {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(Number(BigInt.asUintN(32, BigInt(value))), 0);
    return b;
  }
  if (type === 'sint32' || type === 'sint64') {
    const n = BigInt(value);
    return encodeVarint((n << 1n) ^ (n >> 63n));
  }
  return encodeVarint(value);
}

function wireTypeOf(type) {
  if (WIRE_VARINT.has(type)) return 0;
  if (WIRE_64.has(type)) return 1;
  if (type === 'string' || type === 'bytes' || type === 'message') return 2;
  if (WIRE_32.has(type)) return 5;
  throw new Error(`unsupported protobuf field type: ${type}`);
}

function encodeBody(typeName, value, field) {
  if (field.type === 'message') {
    const nested = encode(typeName, value);
    return Buffer.concat([encodeVarint(nested.length), nested]);
  }
  const raw = encodeScalar(field.type, field.typeName, value);
  if (field.type === 'string' || field.type === 'bytes') {
    return Buffer.concat([encodeVarint(raw.length), raw]);
  }
  return raw;
}

function encodeMessage(typeName, value) {
  const type = messageType(typeName);
  const parts = [];
  for (const field of type.fields) {
    const current = value?.[field.name];
    if (current === undefined || current === null) continue;
    if (field.label === 'repeated') {
      if (!Array.isArray(current)) throw new Error(`${typeName}.${field.name} must be an array`);
      if (current.length === 0) continue;
      if (WIRE_VARINT.has(field.type) && field.type !== 'string' && field.type !== 'bytes') {
        const packed = Buffer.concat(current.map((item) => encodeScalar(field.type, field.typeName, item)));
        parts.push(tag(field.number, 2), encodeVarint(packed.length), packed);
      } else {
        for (const item of current) {
          parts.push(tag(field.number, wireTypeOf(field.type)), encodeBody(field.typeName, item, field));
        }
      }
      continue;
    }
    if (field.type === 'message') {
      parts.push(tag(field.number, 2), encodeBody(field.typeName, current, field));
    } else {
      parts.push(tag(field.number, wireTypeOf(field.type)), encodeBody(field.typeName, current, field));
    }
  }
  return Buffer.concat(parts);
}

function skipField(buf, offset, wireType) {
  if (wireType === 0) return decodeVarint(buf, offset)[1];
  if (wireType === 1) return offset + 8;
  if (wireType === 2) {
    const [len, start] = decodeVarint(buf, offset);
    return start + Number(len);
  }
  if (wireType === 5) return offset + 4;
  throw new Error(`unsupported wire type ${wireType}`);
}

function decodeScalar(type, typeName, buf, offset, wireType) {
  if (type === 'string') {
    const [len, start] = decodeVarint(buf, offset);
    return [buf.toString('utf8', start, start + Number(len)), start + Number(len)];
  }
  if (type === 'bytes') {
    const [len, start] = decodeVarint(buf, offset);
    return [buf.subarray(start, start + Number(len)), start + Number(len)];
  }
  if (type === 'double') return [buf.readDoubleLE(offset), offset + 8];
  if (type === 'float') return [buf.readFloatLE(offset), offset + 4];
  if (type === 'fixed64') return [asNumber(buf.readBigUInt64LE(offset)), offset + 8];
  if (type === 'sfixed64') return [asNumber(buf.readBigInt64LE(offset)), offset + 8];
  if (type === 'fixed32') return [buf.readUInt32LE(offset), offset + 4];
  if (type === 'sfixed32') return [buf.readInt32LE(offset), offset + 4];
  const [raw, next] = decodeVarint(buf, offset);
  if (type === 'bool') return [raw !== 0n, next];
  if (type === 'sint32' || type === 'sint64') {
    const n = (raw >> 1n) ^ -(raw & 1n);
    return [asNumber(n), next];
  }
  if (type === 'int32' || type === 'int64' || type === 'uint32' || type === 'uint64' || type === 'enum') {
    return [asNumber(type === 'uint64' ? BigInt.asUintN(64, raw) : raw), next];
  }
  throw new Error(`unsupported protobuf scalar type: ${type}`);
}

function decodeMessage(typeName, buf) {
  const type = messageType(typeName);
  const fields = new Map(type.fields.map((field) => [field.number, field]));
  const out = {};
  let offset = 0;
  while (offset < buf.length) {
    const [rawTag, next] = decodeVarint(buf, offset);
    offset = next;
    const fieldNumber = Number(rawTag >> 3n);
    const wireType = Number(rawTag & 7n);
    if (fieldNumber === 0) throw new Error('invalid protobuf tag 0');
    const field = fields.get(fieldNumber);
    if (!field) {
      offset = skipField(buf, offset, wireType);
      continue;
    }
    if (field.label === 'repeated') {
      if (!out[field.name]) out[field.name] = [];
      if (wireType === 2 && WIRE_VARINT.has(field.type) && field.type !== 'string' && field.type !== 'bytes') {
        const [len, start] = decodeVarint(buf, offset);
        let cursor = start;
        const end = start + Number(len);
        while (cursor < end) {
          const [item, nextCursor] = decodeScalar(field.type, field.typeName, buf, cursor, 0);
          out[field.name].push(item);
          cursor = nextCursor;
        }
        offset = end;
      } else if (field.type === 'message') {
        const [len, start] = decodeVarint(buf, offset);
        out[field.name].push(decodeMessage(field.typeName, buf.subarray(start, start + Number(len))));
        offset = start + Number(len);
      } else {
        const [item, nextCursor] = decodeScalar(field.type, field.typeName, buf, offset, wireType);
        out[field.name].push(item);
        offset = nextCursor;
      }
      continue;
    }
    if (field.type === 'message') {
      const [len, start] = decodeVarint(buf, offset);
      out[field.name] = decodeMessage(field.typeName, buf.subarray(start, start + Number(len)));
      offset = start + Number(len);
    } else {
      const [item, nextCursor] = decodeScalar(field.type, field.typeName, buf, offset, wireType);
      out[field.name] = item;
      offset = nextCursor;
    }
  }
  if (typeName === 'google.protobuf.Struct') {
    const object = {};
    for (const entry of out.fields || []) object[entry.key] = fromPbValue(entry.value);
    return object;
  }
  return out;
}

function toPbValue(value) {
  if (value === null || value === undefined) return { null_value: 'NULL_VALUE' };
  if (typeof value === 'string') return { string_value: value };
  if (typeof value === 'number') return { number_value: value };
  if (typeof value === 'boolean') return { bool_value: value };
  if (Array.isArray(value)) return { list_value: { values: value.map(toPbValue) } };
  if (typeof value === 'object') {
    return { struct_value: { fields: Object.entries(value).map(([key, item]) => ({ key, value: toPbValue(item) })) } };
  }
  return { null_value: 'NULL_VALUE' };
}

function fromPbValue(value) {
  if (!value) return null;
  if (value.null_value !== undefined) return null;
  if (value.string_value !== undefined) return value.string_value;
  if (value.number_value !== undefined) return value.number_value;
  if (value.bool_value !== undefined) return value.bool_value;
  if (value.list_value) return (value.list_value.values || []).map(fromPbValue);
  if (value.struct_value) {
    const result = {};
    for (const entry of value.struct_value.fields || []) result[entry.key] = fromPbValue(entry.value);
    return result;
  }
  return null;
}

/** Encode a plain JS object as one schema message. */
export function encode(typeName, value) {
  if (typeName === 'google.protobuf.Struct' && !Array.isArray(value?.fields)) {
    const fields = Object.entries(value || {}).map(([key, item]) => ({ key, value: toPbValue(item) }));
    return encodeMessage(typeName, { fields });
  }
  return encodeMessage(typeName, value);
}

/** Decode one buffer as a schema message. */
export function decode(typeName, buffer) {
  return decodeMessage(typeName, buffer);
}

/** Find the set field of a named oneof. */
export function oneof(typeName, value, group) {
  const names = schema.messages[typeName]?.oneofs?.[group];
  if (!names) throw new Error(`${typeName} has no oneof ${group}`);
  for (const name of names) {
    if (value && value[name] !== undefined) return name;
  }
  return undefined;
}

/** Look up an enum's symbolic name, for diagnostics. */
export function enumName(typeName, number) {
  const values = schema.enums[typeName];
  if (!values) return String(number);
  for (const [name, value] of Object.entries(values)) if (value === number) return name;
  return String(number);
}

export const types = schema.messages;
export const enums = schema.enums;
