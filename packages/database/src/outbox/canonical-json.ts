import { encodeCanonicalJson, type JsonValue } from '@pertexo/node-sdk';
import { isWellFormed, utf8ByteLength } from '@pertexo/workflow-model';
import { types as nodeTypes } from 'node:util';

export class BoundedJsonInvalidError extends TypeError {
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

class CanonicalJsonSizer {
  #bytes = 0;
  #databaseBytes = 0;
  #members = 0;

  public constructor(
    private readonly maximumBytes: number,
    private readonly maximumDatabaseBytes: number | undefined,
    private readonly label: string,
  ) {}

  public append(token: string, databaseToken = token): void {
    this.#bytes += utf8ByteLength(token);
    if (this.#bytes > this.maximumBytes)
      throw new BoundedJsonInvalidError(
        `${this.label} must not exceed ${String(this.maximumBytes)} UTF-8 bytes`,
      );
    this.#databaseBytes += utf8ByteLength(databaseToken);
    if (
      this.maximumDatabaseBytes !== undefined &&
      this.#databaseBytes > this.maximumDatabaseBytes
    )
      throw new BoundedJsonInvalidError(
        `${this.label} exceeds the PostgreSQL JSONB ${String(this.maximumDatabaseBytes)}-byte backstop`,
      );
  }

  public admitMembers(count: number, maximumMembers?: number): void {
    this.#members += count;
    if (maximumMembers !== undefined && this.#members > maximumMembers)
      throw new BoundedJsonInvalidError(
        `${this.label} exceeds its member limit`,
      );
  }
}

function writeCanonicalScalar(
  value: unknown,
  writer: CanonicalJsonSizer,
): boolean {
  const primitiveValue =
    value === null || typeof value === 'boolean' || typeof value === 'string';
  if (primitiveValue) {
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
  const requiresPlainObject =
    !array && (constraints?.plainObjectsOnly ?? false);
  if (requiresPlainObject) {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw new BoundedJsonInvalidError(`${label} must contain plain objects`);
  }
  const hasRejectedSymbols =
    (constraints?.rejectSymbols ?? false) &&
    Object.getOwnPropertySymbols(value).length !== 0;
  if (hasRejectedSymbols)
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

// Admission also bounds PostgreSQL JSONB text and rejects accessors/proxies.
// The shared encoder's lexical profile preserves persisted outbox checksums.
export function canonicalJson(
  value: unknown,
  maximumBytes: number,
  {
    maximumDatabaseBytes,
    label = 'canonical JSON payload',
    constraints,
  }: Readonly<{
    maximumDatabaseBytes?: number | undefined;
    label?: string | undefined;
    constraints?: CanonicalJsonConstraints | undefined;
  }> = {},
): string {
  const frames: CanonicalFrame[] = [{ depth: 0, kind: 'value', value }];
  const active = new Set<object>();
  const writer = new CanonicalJsonSizer(
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
    const invalidArrayItem =
      item === null || typeof item !== 'object' || nodeTypes.isProxy(item);
    if (invalidArrayItem) throw new BoundedJsonInvalidError();
    if (active.has(item)) throw new BoundedJsonInvalidError();
    if (constraints !== undefined && frame.depth >= constraints.maximumDepth)
      throw new BoundedJsonInvalidError(`${label} exceeds its depth limit`);

    const container = inspectCanonicalContainer(item, constraints, label);
    writer.admitMembers(container.entries.length, constraints?.maximumMembers);
    active.add(item);
    pushCanonicalContainer(frames, frame, item, container);
  }
  return encodeCanonicalJson(value as JsonValue, 'lexical');
}

function assertPostgresJsonString(value: string): void {
  if (value.includes('\0') || !isWellFormed(value))
    throw new BoundedJsonInvalidError();
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
