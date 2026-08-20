import { isActorContext } from './actor-context.js';
import type { ActorContext } from './types.js';

const MAX_METADATA_KEYS = 64;
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_STRING = 1_000;
const MAX_METADATA_ARRAY = 64;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const sensitiveKeyPattern =
  /(access[_-]?key|api[_-]?key|authorization|bearer|cookie|credential|passphrase|password|pkce|private[_-]?key|secret|session[_-]?id|token)/iu;
const prototypeKeyPattern = /^(?:__proto__|constructor|prototype)$/u;

interface SafeMetadataRecord {
  readonly [key: string]: SafeMetadata;
}

type SafeMetadata =
  | string
  | number
  | boolean
  | null
  | readonly SafeMetadata[]
  | SafeMetadataRecord;

export type AuditFact = Readonly<{
  event: string;
  actorId: string;
  actorKind: 'user';
  workspaceId: string;
  requestId: string;
  traceId?: string;
  target?: Readonly<{ type: string; id: string }>;
  metadata: Readonly<Record<string, SafeMetadata>>;
}>;

export type AuditFactInput = Readonly<{
  event: string;
  actor: ActorContext;
  target?: Readonly<Record<string, unknown>>;
  metadata?: unknown;
  requestId?: string;
  traceId?: string;
}>;

export class AuditFactError extends TypeError {
  public readonly code = 'request.invalid' as const;

  public constructor(message: string) {
    super(`audit metadata ${message}`);
    this.name = 'AuditFactError';
  }
}

function invalid(message: string): AuditFactError {
  return new AuditFactError(message);
}

function nullRecord(): Record<string, SafeMetadata> {
  return Object.create(null) as Record<string, SafeMetadata>;
}

function safeId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !safeIdentifierPattern.test(value)) {
    throw new AuditFactError(`${name} must be a bounded safe identifier`);
  }
  return value;
}

function sanitize(
  value: unknown,
  depth: number,
  counter: { count: number },
): SafeMetadata | undefined {
  if (depth > MAX_METADATA_DEPTH) {
    throw invalid('exceeds the maximum depth');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    if (typeof value === 'string' && value.length > MAX_METADATA_STRING) {
      throw invalid('contains an oversized string');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalid('contains a non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY) {
      throw invalid('contains an oversized array');
    }
    const items = value.flatMap((item) => {
      const safe = sanitize(item, depth + 1, counter);
      return safe === undefined ? [] : [safe];
    });
    return Object.freeze(items);
  }
  if (typeof value !== 'object') {
    throw invalid('contains an unsupported value');
  }

  const result = nullRecord();
  for (const [key, item] of Object.entries(value)) {
    counter.count += 1;
    if (counter.count > MAX_METADATA_KEYS) {
      throw invalid('contains too many keys');
    }
    if (prototypeKeyPattern.test(key)) {
      throw invalid('contains a prototype-shaped key');
    }
    if (sensitiveKeyPattern.test(key)) {
      continue;
    }
    const safe = sanitize(item, depth + 1, counter);
    if (safe !== undefined) {
      result[key] = safe;
    }
  }
  return Object.freeze(result);
}

function safeMetadata(value: unknown): Readonly<Record<string, SafeMetadata>> {
  if (value === undefined) {
    return Object.freeze(nullRecord());
  }
  const result = sanitize(value, 0, { count: 0 });
  if (!isMetadataRecord(result)) {
    throw invalid('must be an object');
  }
  return result;
}

function isMetadataRecord(
  value: SafeMetadata | undefined,
): value is SafeMetadataRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeTarget(
  target: Readonly<Record<string, unknown>> | undefined,
): AuditFact['target'] {
  if (target === undefined) {
    return undefined;
  }
  for (const key of Object.keys(target)) {
    if (prototypeKeyPattern.test(key)) {
      throw invalid('target contains a prototype-shaped field');
    }
    if (sensitiveKeyPattern.test(key)) {
      throw invalid('target contains a credential-shaped field');
    }
  }
  const type = safeId(target.type, 'target type');
  const id = safeId(target.id, 'target id');
  return Object.freeze({ type, id });
}

export function buildAuditFact(input: AuditFactInput): AuditFact {
  if (!isActorContext(input.actor)) {
    throw new AuditFactError('actor context is invalid');
  }
  const event = safeId(input.event, 'event');
  const metadata = safeMetadata(input.metadata);
  const target = safeTarget(input.target);
  const fact: AuditFact = {
    event,
    actorId: input.actor.actorId,
    actorKind: input.actor.kind,
    workspaceId: input.actor.workspaceId,
    requestId: safeId(input.requestId ?? input.actor.requestId, 'request id'),
    ...(input.traceId === undefined && input.actor.traceId === undefined
      ? {}
      : { traceId: safeId(input.traceId ?? input.actor.traceId, 'trace id') }),
    ...(target === undefined ? {} : { target }),
    metadata,
  };
  return Object.freeze(fact);
}
