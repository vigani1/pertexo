import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import { z } from 'zod';

import { outboxEvents } from '../schema.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

const checksumSchema = sha256HexSchema;
const outboxEventInputSchema = z
  .object({
    id: z.uuid(),
    jobName: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u),
    schemaVersion: z.number().int().positive().max(32_767),
    aggregateType: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/u),
    aggregateId: z.uuid(),
    payload: z.unknown(),
    payloadChecksum: checksumSchema,
    availableAt: z.date().optional(),
  })
  .strict();

type JsonPrimitive = null | boolean | number | string;
interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

const OUTBOX_PAYLOAD_BYTES = 4096;

class BoundedJsonInvalidError extends TypeError {
  public constructor(message = 'outbox payload must be valid bounded JSON') {
    super(message);
    this.name = 'BoundedJsonInvalidError';
  }
}

type CanonicalFrame =
  | Readonly<{ depth: number; kind: 'value'; value: unknown }>
  | Readonly<{ kind: 'token'; token: string }>
  | Readonly<{ kind: 'exit'; value: object }>;

type CanonicalJsonConstraints = Readonly<{
  maximumDepth: number;
  maximumMembers: number;
  plainObjectsOnly: boolean;
  rejectSymbols: boolean;
}>;

type CanonicalContainer = Readonly<{
  array: boolean;
  entries: readonly (readonly [string, unknown])[];
}>;

class CanonicalJsonWriter {
  readonly #chunks: string[] = [];
  #bytes = 0;
  #databaseBytes = 0;
  #members = 0;

  public constructor(
    private readonly maximumBytes: number,
    private readonly maximumDatabaseBytes: number | undefined,
    private readonly label: string,
  ) {}

  public append(token: string, databaseToken = token): void {
    this.#bytes += Buffer.byteLength(token, 'utf8');
    if (this.#bytes > this.maximumBytes)
      throw new BoundedJsonInvalidError(
        `${this.label} must not exceed ${String(this.maximumBytes)} UTF-8 bytes`,
      );
    this.#databaseBytes += Buffer.byteLength(databaseToken, 'utf8');
    if (
      this.maximumDatabaseBytes !== undefined &&
      this.#databaseBytes > this.maximumDatabaseBytes
    )
      throw new BoundedJsonInvalidError(
        `${this.label} exceeds the PostgreSQL JSONB ${String(this.maximumDatabaseBytes)}-byte backstop`,
      );
    this.#chunks.push(token);
  }

  public admitMembers(count: number, maximumMembers?: number): void {
    this.#members += count;
    if (maximumMembers !== undefined && this.#members > maximumMembers)
      throw new BoundedJsonInvalidError(
        `${this.label} exceeds its member limit`,
      );
  }

  public result(): string {
    return this.#chunks.join('');
  }
}

function writeCanonicalScalar(
  value: unknown,
  writer: CanonicalJsonWriter,
): boolean {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    if (typeof value === 'string') assertPostgresJsonString(value);
    writer.append(JSON.stringify(value));
    return true;
  }
  if (typeof value !== 'number') return false;
  if (!Number.isFinite(value)) throw new BoundedJsonInvalidError();
  const jsonNumber = JSON.stringify(value);
  writer.append(jsonNumber, expandJsonNumber(jsonNumber));
  return true;
}

function inspectCanonicalContainer(
  value: object,
  constraints: CanonicalJsonConstraints | undefined,
  label: string,
): CanonicalContainer {
  const array = Array.isArray(value);
  if (!array && constraints?.plainObjectsOnly === true) {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw new BoundedJsonInvalidError(`${label} must contain plain objects`);
  }
  if (
    constraints?.rejectSymbols === true &&
    Object.getOwnPropertySymbols(value).length !== 0
  )
    throw new BoundedJsonInvalidError(
      `${label} must not contain symbol properties`,
    );

  const entries: (readonly [string, unknown])[] = [];
  if (array) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor))
        throw new BoundedJsonInvalidError();
      entries.push([String(index), descriptor.value]);
    }
    const unexpected = Object.keys(value).some(
      (key, index) => key !== String(index),
    );
    if (unexpected) throw new BoundedJsonInvalidError();
  } else {
    for (const key of Object.keys(value).sort()) {
      assertPostgresJsonString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor))
        throw new BoundedJsonInvalidError();
      entries.push([key, descriptor.value]);
    }
  }
  return { array, entries };
}

function pushCanonicalContainer(
  frames: CanonicalFrame[],
  frame: Extract<CanonicalFrame, { readonly kind: 'value' }>,
  value: object,
  container: CanonicalContainer,
): void {
  frames.push({ kind: 'exit', value });
  frames.push({ kind: 'token', token: container.array ? ']' : '}' });
  for (let index = container.entries.length - 1; index >= 0; index -= 1) {
    const entry = container.entries[index];
    if (entry === undefined) throw new BoundedJsonInvalidError();
    frames.push({ depth: frame.depth + 1, kind: 'value', value: entry[1] });
    if (!container.array) {
      frames.push({ kind: 'token', token: ':' });
      frames.push({ kind: 'token', token: JSON.stringify(entry[0]) });
    }
    if (index !== 0) frames.push({ kind: 'token', token: ',' });
  }
  frames.push({ kind: 'token', token: container.array ? '[' : '{' });
}

function canonicalJson(
  value: unknown,
  maximumBytes: number,
  maximumDatabaseBytes?: number,
  label = 'canonical JSON payload',
  constraints?: CanonicalJsonConstraints,
): string {
  const frames: CanonicalFrame[] = [{ depth: 0, kind: 'value', value }];
  const active = new Set<object>();
  const writer = new CanonicalJsonWriter(
    maximumBytes,
    maximumDatabaseBytes,
    label,
  );

  while (frames.length !== 0) {
    const frame = frames.pop();
    if (frame === undefined) throw new BoundedJsonInvalidError();
    if (frame.kind === 'token') {
      writer.append(
        frame.token,
        frame.token === ':' || frame.token === ','
          ? `${frame.token} `
          : frame.token,
      );
      continue;
    }
    if (frame.kind === 'exit') {
      active.delete(frame.value);
      continue;
    }

    const item = frame.value;
    if (writeCanonicalScalar(item, writer)) continue;
    if (item === null || typeof item !== 'object' || nodeTypes.isProxy(item))
      throw new BoundedJsonInvalidError();
    if (active.has(item)) throw new BoundedJsonInvalidError();
    if (constraints !== undefined && frame.depth >= constraints.maximumDepth)
      throw new BoundedJsonInvalidError(`${label} exceeds its depth limit`);

    const container = inspectCanonicalContainer(item, constraints, label);
    writer.admitMembers(container.entries.length, constraints?.maximumMembers);
    active.add(item);
    pushCanonicalContainer(frames, frame, item, container);
  }
  return writer.result();
}

function assertPostgresJsonString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || (code >= 0xdc00 && code <= 0xdfff))
      throw new BoundedJsonInvalidError();
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new BoundedJsonInvalidError();
      index += 1;
    }
  }
}

function expandJsonNumber(value: string): string {
  const exponentAt = value.search(/[eE]/u);
  if (exponentAt === -1) return value;
  const mantissa = value.slice(0, exponentAt);
  const exponent = Number(value.slice(exponentAt + 1));
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const decimalAt = unsigned.indexOf('.');
  const integerDigits = decimalAt === -1 ? unsigned.length : decimalAt;
  const digits = unsigned.replace('.', '');
  const decimalPosition = integerDigits + exponent;
  const sign = negative ? '-' : '';
  if (decimalPosition <= 0)
    return `${sign}0.${'0'.repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length)
    return `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

export function canonicalOutboxPayloadChecksum(payload: unknown): string {
  return createHash('sha256')
    .update(
      canonicalJson(
        payload,
        OUTBOX_PAYLOAD_BYTES,
        OUTBOX_PAYLOAD_BYTES,
        'outbox payload',
      ),
    )
    .digest('hex');
}

/** Internal bounded canonical hash for non-outbox idempotency request bodies. */
export function canonicalApplicationPayloadChecksum(
  payload: unknown,
  maximumBytes: number,
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new TypeError('canonical JSON payload byte limit is invalid');
  return createHash('sha256')
    .update(canonicalJson(payload, maximumBytes))
    .digest('hex');
}

/** Immutable, descriptor-safe operator input serialization with explicit bounds. */
export function serializeBoundedPlainJson(
  payload: unknown,
  maximumBytes: number,
  label: string,
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new TypeError(`${label} byte limit is invalid`);
  try {
    return canonicalJson(payload, maximumBytes, undefined, label, {
      maximumDepth: 64,
      maximumMembers: 10_000,
      plainObjectsOnly: true,
      rejectSymbols: true,
    });
  } catch (error: unknown) {
    let boundedFailure = false;
    try {
      boundedFailure = error instanceof BoundedJsonInvalidError;
    } catch {
      // A hostile thrown value is normalized below without further inspection.
    }
    if (boundedFailure) throw error;
    throw new BoundedJsonInvalidError(`${label} could not be inspected safely`);
  }
}

export type OutboxEventInput = Readonly<z.input<typeof outboxEventInputSchema>>;
export type InsertedOutboxEvent = Readonly<{
  id: string;
  workspaceId: string;
  availableAt: Date;
}>;

export async function insertOutboxEvent(
  transaction: WorkspaceTransaction,
  input: OutboxEventInput,
): Promise<InsertedOutboxEvent> {
  const parsed = outboxEventInputSchema.parse(input);
  const canonicalPayload = canonicalJson(
    parsed.payload,
    OUTBOX_PAYLOAD_BYTES,
    OUTBOX_PAYLOAD_BYTES,
    'outbox payload',
  );
  if (
    createHash('sha256').update(canonicalPayload).digest('hex') !==
    parsed.payloadChecksum
  ) {
    throw new Error(
      'outbox payload checksum does not match its canonical JSON',
    );
  }
  const rows = await transaction.db
    .insert(outboxEvents)
    .values({
      id: parsed.id,
      workspaceId: transaction.workspaceId,
      jobName: parsed.jobName,
      schemaVersion: parsed.schemaVersion,
      aggregateType: parsed.aggregateType,
      aggregateId: parsed.aggregateId,
      payload: JSON.parse(canonicalPayload) as JsonValue,
      payloadChecksum: parsed.payloadChecksum,
      ...(parsed.availableAt === undefined
        ? {}
        : { availableAt: parsed.availableAt }),
    })
    .returning({
      id: outboxEvents.id,
      workspaceId: outboxEvents.workspaceId,
      availableAt: outboxEvents.availableAt,
    });
  const row = rows[0];
  if (row === undefined) {
    throw new Error('Outbox insert returned no row');
  }
  return Object.freeze(row);
}

export { checksumSchema as outboxChecksumSchema };
