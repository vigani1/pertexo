import { z } from 'zod';

/** A stable identity is never resolved by version ordering or by a latest fallback. */
export interface DefinitionIdentity {
  readonly key: string;
  readonly version: number;
}

export interface ExecutorIdentity {
  readonly key: string;
  readonly version: number;
}

export interface PolicyReference {
  readonly key: string;
  readonly version: number;
}

export type NodeFamily =
  'trigger' | 'action' | 'logic' | 'transform' | 'output';

export type DefinitionLifecycle =
  'active' | 'deprecated' | 'migration_required' | 'retired';

export type ExecutorLifecycle =
  'staged' | 'active' | 'retained' | 'retirement_blocked' | 'retired';

export const DEFINITION_LIFECYCLE_TRANSITIONS: Readonly<
  Record<DefinitionLifecycle, readonly DefinitionLifecycle[]>
> = Object.freeze({
  active: Object.freeze<DefinitionLifecycle[]>([
    'deprecated',
    'migration_required',
  ]),
  deprecated: Object.freeze<DefinitionLifecycle[]>([
    'migration_required',
    'retired',
  ]),
  migration_required: Object.freeze<DefinitionLifecycle[]>(['retired']),
  retired: Object.freeze<DefinitionLifecycle[]>([]),
});

export const EXECUTOR_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ExecutorLifecycle, readonly ExecutorLifecycle[]>
> = Object.freeze({
  staged: Object.freeze<ExecutorLifecycle[]>(['active']),
  active: Object.freeze<ExecutorLifecycle[]>(['retained']),
  retained: Object.freeze<ExecutorLifecycle[]>(['retirement_blocked']),
  retirement_blocked: Object.freeze<ExecutorLifecycle[]>([
    'retained',
    'retired',
  ]),
  retired: Object.freeze<ExecutorLifecycle[]>([]),
});

export type RetryClass = 'safe' | 'idempotent-with-key' | 'unsafe';
export type ResourceClass = 'io' | 'cpu';

export type SchemaJson =
  null | boolean | number | string | readonly SchemaJson[] | SchemaObject;

// Recursive JSON contracts cannot be expressed through a finite Record alias.
export interface SchemaObject {
  readonly [key: string]: SchemaJson;
}

export type SchemaDocument = Readonly<Record<string, SchemaJson>>;

export const NODE_JSON_LIMITS_V1 = Object.freeze({
  bytes: 1_048_576,
  depth: 64,
  members: 10_000,
});

export interface NodePorts {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

/** Stable provider operation identity used by derived workflow impact indexes. */
export interface NodeIntegrationOperation {
  readonly providerKey: string;
  readonly operationKey: string;
}

export interface NodeManifest {
  readonly schemaVersion: 1;
  readonly definition: DefinitionIdentity;
  readonly family: NodeFamily;
  readonly configVersion: number;
  readonly configSchema: SchemaDocument;
  readonly inputSchema: SchemaDocument;
  readonly outputSchema: SchemaDocument;
  readonly ports: NodePorts;
  readonly credentialRequirements: readonly string[];
  readonly connectionRequirements: readonly string[];
  readonly integration?: NodeIntegrationOperation | undefined;
  readonly retryClass: RetryClass;
  readonly resourceClass: ResourceClass;
  readonly capabilities: readonly string[];
  readonly lifecycle: DefinitionLifecycle;
  readonly executor: ExecutorIdentity;
  readonly executorAbi?: number | undefined;
  readonly policyReferences: readonly PolicyReference[];
}

export interface ExecutorManifest {
  readonly executor: ExecutorIdentity;
  readonly abiVersion: number;
  readonly definitions: readonly DefinitionIdentity[];
  readonly lifecycle: ExecutorLifecycle;
  readonly policyReferences: readonly PolicyReference[];
}

export interface RegistryRelease {
  readonly schemaVersion: 1;
  readonly epoch: number;
  readonly definitions: readonly NodeManifest[];
  readonly executors: readonly ExecutorManifest[];
  readonly policies: readonly PolicyReference[];
  readonly fingerprint: string;
}

export interface RegistryReleaseInput {
  readonly epoch: number;
  readonly definitions: readonly NodeManifest[];
  readonly executors: readonly ExecutorManifest[];
  readonly policies: readonly PolicyReference[];
}

export const TERMINATES_RUN_CAPABILITY = 'terminates_run' as const;

const identityKey = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u;
const identitySchema = z
  .object({
    key: z.string().regex(identityKey),
    version: z.number().int().positive(),
  })
  .strict();
const policyReferenceSchema = identitySchema;

export function isBoundedNodeJson(value: unknown): value is SchemaJson {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      NODE_JSON_LIMITS_V1.bytes
    );
  if (typeof value !== 'object') return false;
  const stack: { readonly value: object; readonly depth: number }[] = [
    { value, depth: 1 },
  ];
  const seen = new Set<object>();
  let members = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.depth > NODE_JSON_LIMITS_V1.depth || seen.has(current.value))
      return false;
    seen.add(current.value);
    if (
      !Array.isArray(current.value) &&
      Object.getPrototypeOf(current.value) !== Object.prototype &&
      Object.getPrototypeOf(current.value) !== null
    )
      return false;
    if (Object.getOwnPropertySymbols(current.value).length > 0) return false;
    if (
      Array.isArray(current.value) &&
      current.value.length > NODE_JSON_LIMITS_V1.members
    )
      return false;
    const keys = Array.isArray(current.value)
      ? Array.from({ length: current.value.length }, (_, index) =>
          String(index),
        )
      : Object.keys(current.value);
    if (
      Array.isArray(current.value) &&
      (Object.keys(current.value).length !== current.value.length ||
        keys.some((key) => !(Number(key) in current.value)))
    )
      return false;
    for (const key of keys) {
      members += 1;
      if (members > NODE_JSON_LIMITS_V1.members) return false;
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (descriptor === undefined || !('value' in descriptor)) return false;
      const child: unknown = descriptor.value;
      if (
        child === null ||
        typeof child === 'string' ||
        typeof child === 'boolean' ||
        (typeof child === 'number' && Number.isFinite(child))
      )
        continue;
      if (typeof child !== 'object') return false;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      NODE_JSON_LIMITS_V1.bytes
    );
  } catch {
    return false;
  }
}

export const boundedNodeJsonSchema: z.ZodType<SchemaJson> =
  z.custom<SchemaJson>(isBoundedNodeJson, {
    message: 'value exceeds the bounded node JSON contract',
  });

export const boundedNodeJsonRecordSchema: z.ZodType<SchemaDocument> =
  boundedNodeJsonSchema.refine(
    (value): value is SchemaDocument =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
    'value must be a JSON object',
  );

function isSchemaDocument(value: unknown): value is SchemaDocument {
  return (
    isBoundedNodeJson(value) &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

const schemaDocumentSchema = z.custom<SchemaDocument>(isSchemaDocument, {
  error: 'schema must be bounded JSON object',
});
const identifiersSchema = z
  .array(z.string().min(1))
  .refine(
    (values) => new Set(values).size === values.length,
    'identifiers must be unique',
  );
const portsSchema = z
  .object({ inputs: identifiersSchema, outputs: identifiersSchema })
  .strict();
const integrationOperationSchema = z
  .object({
    providerKey: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
    operationKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
  })
  .strict();

export const definitionIdentitySchema = identitySchema;
export const executorIdentitySchema = identitySchema;
export const policyReferenceSchemaV1 = policyReferenceSchema;

function boundedSchemaDocument(kind: 'value' | 'record'): SchemaDocument {
  const structural = z.toJSONSchema(
    kind === 'value' ? z.json() : z.record(z.string(), z.json()),
  );
  return cloneAndFreeze(
    schemaDocumentSchema.parse({
      ...structural,
      'x-pertexo-node-json-limits': NODE_JSON_LIMITS_V1,
    }),
  );
}

export const BOUNDED_NODE_JSON_SCHEMA_DOCUMENT = boundedSchemaDocument('value');
export const BOUNDED_NODE_JSON_RECORD_SCHEMA_DOCUMENT =
  boundedSchemaDocument('record');

export function generateSchemaDocument(schema: z.ZodType): SchemaDocument {
  if (schema === boundedNodeJsonSchema)
    return BOUNDED_NODE_JSON_SCHEMA_DOCUMENT;
  if (schema === boundedNodeJsonRecordSchema)
    return BOUNDED_NODE_JSON_RECORD_SCHEMA_DOCUMENT;
  return cloneAndFreeze(schemaDocumentSchema.parse(z.toJSONSchema(schema)));
}

export const nodeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    definition: definitionIdentitySchema,
    family: z.enum(['trigger', 'action', 'logic', 'transform', 'output']),
    configVersion: z.number().int().positive(),
    configSchema: schemaDocumentSchema,
    inputSchema: schemaDocumentSchema,
    outputSchema: schemaDocumentSchema,
    ports: portsSchema,
    credentialRequirements: identifiersSchema,
    connectionRequirements: identifiersSchema,
    integration: integrationOperationSchema.optional(),
    retryClass: z.enum(['safe', 'idempotent-with-key', 'unsafe']),
    resourceClass: z.enum(['io', 'cpu']),
    capabilities: identifiersSchema,
    lifecycle: z.enum([
      'active',
      'deprecated',
      'migration_required',
      'retired',
    ]),
    executor: executorIdentitySchema,
    executorAbi: z.number().int().positive().optional(),
    policyReferences: z.array(policyReferenceSchema),
  })
  .strict();

export const executorManifestSchema = z
  .object({
    executor: executorIdentitySchema,
    abiVersion: z.number().int().positive(),
    definitions: z.array(definitionIdentitySchema),
    lifecycle: z.enum([
      'staged',
      'active',
      'retained',
      'retirement_blocked',
      'retired',
    ]),
    policyReferences: z.array(policyReferenceSchema),
  })
  .strict();

const registryReleaseInputSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    epoch: z.number().int().positive(),
    definitions: z.array(nodeManifestSchema),
    executors: z.array(executorManifestSchema),
    policies: z.array(policyReferenceSchema),
  })
  .strict();

export const registryReleaseSchema = registryReleaseInputSchema
  .extend({
    fingerprint: z.string().regex(/^node-compat:v1:sha256:[a-f0-9]{64}$/u),
  })
  .strict();

function identityToken(
  identity: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): string {
  return `${identity.key}\u0000${String(identity.version)}`;
}

function compareIdentity(
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): number {
  return left.key < right.key
    ? -1
    : left.key > right.key
      ? 1
      : left.version - right.version;
}

function rejectDuplicateIdentities(
  label: string,
  identities: readonly (
    DefinitionIdentity | ExecutorIdentity | PolicyReference
  )[],
): void {
  const seen = new Set<string>();
  for (const identity of identities) {
    const token = identityToken(identity);
    if (seen.has(token))
      throw new Error(
        `duplicate ${label} identity ${identity.key}@${String(identity.version)}`,
      );
    seen.add(token);
  }
}

function cloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    for (const item of value) copy.push(cloneAndFreeze(item));
    return Object.freeze(copy) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    copy[key] = cloneAndFreeze(item);
  return Object.freeze(copy) as T;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

/** Small synchronous SHA-256 implementation so the browser contract has no Node dependency. */
function sha256Hex(input: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const schedule = new Uint32Array(64);
  const rotateRight = (value: number, amount: number): number =>
    (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1)
      schedule[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const previous = schedule[index - 15] ?? 0;
      const older = schedule[index - 2] ?? 0;
      const sigma0 =
        rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const sigma1 =
        rotateRight(older, 17) ^ rotateRight(older, 19) ^ (older >>> 10);
      const oldest = schedule[index - 16] ?? 0;
      const recent = schedule[index - 7] ?? 0;
      schedule[index] = (oldest + sigma0 + recent + sigma1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 =
        rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const constant = constants[index] ?? 0;
      const scheduled = schedule[index] ?? 0;
      const temporary1 = (h + bigSigma1 + choose + constant + scheduled) >>> 0;
      const bigSigma0 =
        rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

function definitionProjection(manifest: NodeManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    definition: manifest.definition,
    family: manifest.family,
    configVersion: manifest.configVersion,
    configSchema: manifest.configSchema,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    ports: {
      inputs: [...manifest.ports.inputs].sort(),
      outputs: [...manifest.ports.outputs].sort(),
    },
    credentialRequirements: [...manifest.credentialRequirements].sort(),
    connectionRequirements: [...manifest.connectionRequirements].sort(),
    ...(manifest.integration === undefined
      ? {}
      : { integration: manifest.integration }),
    retryClass: manifest.retryClass,
    resourceClass: manifest.resourceClass,
    capabilities: [...manifest.capabilities].sort(),
    lifecycle: manifest.lifecycle,
    executor: manifest.executor,
    executorAbi: manifest.executorAbi ?? null,
    policyReferences: [...manifest.policyReferences].sort(compareIdentity),
  };
}

function executorProjection(executor: ExecutorManifest) {
  return {
    executor: executor.executor,
    abiVersion: executor.abiVersion,
    definitions: [...executor.definitions].sort(compareIdentity),
    lifecycle: executor.lifecycle,
    policyReferences: [...executor.policyReferences].sort(compareIdentity),
  };
}

function releaseProjection(input: RegistryReleaseInput): unknown {
  return {
    domain: 'pertexo.node-compatibility-release',
    schemaVersion: 1,
    definitions: [...input.definitions]
      .sort((left, right) => compareIdentity(left.definition, right.definition))
      .map(definitionProjection),
    executors: [...input.executors]
      .sort((left, right) => compareIdentity(left.executor, right.executor))
      .map(executorProjection),
    policies: [...input.policies].sort(compareIdentity),
  };
}

export function canonicalCompatibilityReleaseJson(
  release: RegistryReleaseInput,
): string {
  return stableJson(releaseProjection(release));
}

export function computeCompatibilityReleaseFingerprint(
  release: RegistryReleaseInput,
): string {
  return `node-compat:v1:sha256:${sha256Hex(canonicalCompatibilityReleaseJson(release))}`;
}

function validateReleaseEdges(input: RegistryReleaseInput): void {
  rejectDuplicateIdentities(
    'definition',
    input.definitions.map(({ definition }) => definition),
  );
  rejectDuplicateIdentities(
    'executor',
    input.executors.map(({ executor }) => executor),
  );
  rejectDuplicateIdentities('policy', input.policies);
  const definitions = new Map(
    input.definitions.map((manifest) => [
      identityToken(manifest.definition),
      manifest,
    ]),
  );
  const executors = new Map(
    input.executors.map((manifest) => [
      identityToken(manifest.executor),
      manifest,
    ]),
  );
  const policies = new Set(input.policies.map(identityToken));
  for (const manifest of input.definitions) {
    const executor = executors.get(identityToken(manifest.executor));
    if (executor === undefined)
      throw new Error(
        `definition ${manifest.definition.key}@${String(manifest.definition.version)} references an unknown executor`,
      );
    if (
      !executor.definitions.some(
        (candidate) =>
          identityToken(candidate) === identityToken(manifest.definition),
      )
    )
      throw new Error(
        `executor ${executor.executor.key}@${String(executor.executor.version)} does not declare definition ${manifest.definition.key}@${String(manifest.definition.version)}`,
      );
    if (
      manifest.executorAbi !== undefined &&
      manifest.executorAbi !== executor.abiVersion
    )
      throw new Error(
        'definition executor ABI does not match its pinned executor',
      );
    if (
      !sameIdentityLists(manifest.policyReferences, executor.policyReferences)
    )
      throw new Error(
        'definition policies do not match its pinned executor policies',
      );
    for (const policy of manifest.policyReferences)
      if (!policies.has(identityToken(policy)))
        throw new Error('definition references an unknown policy');
  }
  for (const executor of input.executors) {
    rejectDuplicateIdentities('executor definition', executor.definitions);
    rejectDuplicateIdentities('executor policy', executor.policyReferences);
    for (const identity of executor.definitions) {
      const definition = definitions.get(identityToken(identity));
      if (
        definition === undefined ||
        identityToken(definition.executor) !== identityToken(executor.executor)
      )
        throw new Error('executor definition edge is not bidirectional');
    }
    for (const policy of executor.policyReferences)
      if (!policies.has(identityToken(policy)))
        throw new Error('executor references an unknown policy');
  }
}

function sameIdentityLists(
  left: readonly (DefinitionIdentity | ExecutorIdentity | PolicyReference)[],
  right: readonly (DefinitionIdentity | ExecutorIdentity | PolicyReference)[],
): boolean {
  if (left.length !== right.length) return false;
  const rightTokens = new Set(right.map(identityToken));
  return left.every((identity) => rightTokens.has(identityToken(identity)));
}

export function computeCompatibilitySelectionFingerprint(
  release: RegistryRelease,
  selectedDefinitions: readonly DefinitionIdentity[],
): string {
  const parsedRelease = parseRegistryRelease(release);
  const definitions = new Map(
    parsedRelease.definitions.map((manifest) => [
      identityToken(manifest.definition),
      manifest,
    ]),
  );
  const executors = new Map(
    parsedRelease.executors.map((manifest) => [
      identityToken(manifest.executor),
      manifest,
    ]),
  );
  const policies = new Map(
    parsedRelease.policies.map((policy) => [identityToken(policy), policy]),
  );
  rejectDuplicateIdentities('selected definition', selectedDefinitions);
  const projection = [...selectedDefinitions]
    .sort(compareIdentity)
    .map((selection) => {
      const definition = definitions.get(identityToken(selection));
      const executor =
        definition === undefined
          ? undefined
          : executors.get(identityToken(definition.executor));
      if (definition === undefined || executor === undefined)
        throw new Error('compatibility selection contains an unknown identity');
      const selectedPolicies = [...definition.policyReferences]
        .sort(compareIdentity)
        .map((policy) => {
          const known = policies.get(identityToken(policy));
          if (known === undefined)
            throw new Error(
              'compatibility selection contains an unknown policy',
            );
          return known;
        });
      return {
        definition: definitionProjection(definition),
        executor: executorProjection(executor),
        policies: selectedPolicies,
      };
    });
  return `node-select:v1:sha256:${sha256Hex(stableJson({ domain: 'pertexo.node-compatibility-selection', selections: projection }))}`;
}

export function createRegistryRelease(
  input: RegistryReleaseInput,
): RegistryRelease {
  const parsed = registryReleaseInputSchema.parse({
    ...input,
    schemaVersion: 1,
  });
  validateReleaseEdges(parsed);
  const normalized = {
    schemaVersion: 1 as const,
    epoch: parsed.epoch,
    definitions: [...parsed.definitions].sort((left, right) =>
      compareIdentity(left.definition, right.definition),
    ),
    executors: [...parsed.executors].sort((left, right) =>
      compareIdentity(left.executor, right.executor),
    ),
    policies: [...parsed.policies].sort(compareIdentity),
  } satisfies RegistryReleaseInput & { readonly schemaVersion: 1 };
  const release = {
    ...normalized,
    fingerprint: computeCompatibilityReleaseFingerprint(normalized),
  } satisfies RegistryRelease;
  return cloneAndFreeze(release);
}

export function parseRegistryRelease(input: unknown): RegistryRelease {
  const parsed = registryReleaseSchema.parse(input);
  validateReleaseEdges(parsed);
  const expected = computeCompatibilityReleaseFingerprint(parsed);
  if (parsed.fingerprint !== expected)
    throw new Error(
      'release fingerprint does not match its canonical projection',
    );
  return cloneAndFreeze(parsed);
}

export type RegistryReleaseSuccessorInput = RegistryReleaseInput &
  Readonly<{ previous: RegistryRelease }>;

function lifecycleTransitionAllowed<State extends string>(
  transitions: Readonly<Record<State, readonly State[]>>,
  previous: State,
  next: State,
): boolean {
  return previous === next || transitions[previous].includes(next);
}

function immutableDefinitionJson(manifest: NodeManifest): string {
  const { lifecycle, ...behavior } = definitionProjection(manifest);
  void lifecycle;
  return stableJson(behavior);
}

function immutableExecutorJson(manifest: ExecutorManifest): string {
  const { lifecycle, ...behavior } = executorProjection(manifest);
  void lifecycle;
  return stableJson(behavior);
}

/**
 * Constructs one audited release successor without reusing an identity for new
 * behavior or skipping a lifecycle gate. Initial/bootstrap and retained-record
 * parsing continue to use createRegistryRelease directly.
 */
export function createRegistryReleaseSuccessor(
  input: RegistryReleaseSuccessorInput,
): RegistryRelease {
  const { previous: previousInput, ...successorInput } = input;
  const previous = parseRegistryRelease(previousInput);
  const next = createRegistryRelease(successorInput);
  if (next.epoch <= previous.epoch)
    throw new Error('compatibility release epoch must increase');

  const nextDefinitions = new Map(
    next.definitions.map((manifest) => [
      identityToken(manifest.definition),
      manifest,
    ]),
  );
  const previousDefinitions = new Map(
    previous.definitions.map((manifest) => [
      identityToken(manifest.definition),
      manifest,
    ]),
  );
  for (const manifest of previous.definitions) {
    const successor = nextDefinitions.get(identityToken(manifest.definition));
    if (successor === undefined) {
      if (manifest.lifecycle !== 'retired')
        throw new Error('definition cannot be removed before retired');
      continue;
    }
    if (
      immutableDefinitionJson(manifest) !== immutableDefinitionJson(successor)
    )
      throw new Error('definition identity behavior cannot change');
    if (
      !lifecycleTransitionAllowed(
        DEFINITION_LIFECYCLE_TRANSITIONS,
        manifest.lifecycle,
        successor.lifecycle,
      )
    )
      throw new Error('definition lifecycle transition is not allowed');
  }
  for (const manifest of next.definitions)
    if (
      !previousDefinitions.has(identityToken(manifest.definition)) &&
      manifest.lifecycle !== 'active'
    )
      throw new Error('new definition must be active');

  const nextExecutors = new Map(
    next.executors.map((manifest) => [
      identityToken(manifest.executor),
      manifest,
    ]),
  );
  const previousExecutors = new Map(
    previous.executors.map((manifest) => [
      identityToken(manifest.executor),
      manifest,
    ]),
  );
  for (const manifest of previous.executors) {
    const successor = nextExecutors.get(identityToken(manifest.executor));
    if (successor === undefined) {
      if (manifest.lifecycle !== 'retired')
        throw new Error('executor cannot be removed before retired');
      continue;
    }
    if (immutableExecutorJson(manifest) !== immutableExecutorJson(successor))
      throw new Error('executor identity behavior cannot change');
    if (
      !lifecycleTransitionAllowed(
        EXECUTOR_LIFECYCLE_TRANSITIONS,
        manifest.lifecycle,
        successor.lifecycle,
      )
    )
      throw new Error('executor lifecycle transition is not allowed');
  }
  for (const manifest of next.executors)
    if (
      !previousExecutors.has(identityToken(manifest.executor)) &&
      manifest.lifecycle !== 'staged'
    )
      throw new Error('new executor must be staged');

  return next;
}
