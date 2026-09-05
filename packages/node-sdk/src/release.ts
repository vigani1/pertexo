import { z } from 'zod';

import {
  cloneAndFreeze,
  computeCompatibilityReleaseFingerprint,
  computeSelectionFingerprintFromParsedRelease,
  definitionProjection,
  executorProjection,
  stableJson,
} from './compatibility-canonical.js';

export {
  canonicalCompatibilityReleaseJson,
  computeCompatibilityReleaseFingerprint,
} from './compatibility-canonical.js';

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

export interface NodeManifestFields {
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
  readonly policyReferences: readonly PolicyReference[];
}

/** Retained manifest grammar. Its optional ABI is preserved for old fingerprints. */
export type NodeManifestV1 = Readonly<
  NodeManifestFields & {
    readonly schemaVersion: 1;
    readonly executorAbi?: number | undefined;
  }
>;

/** Current manifest grammar. New definitions must pin their executor ABI. */
export type NodeManifestV2 = Readonly<
  NodeManifestFields & {
    readonly schemaVersion: 2;
    readonly executorAbi: number;
  }
>;

export type NodeManifest = NodeManifestV1 | NodeManifestV2;

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

function inspectBoundedNodeJson(value: unknown): value is SchemaJson {
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

export function isBoundedNodeJson(value: unknown): value is SchemaJson {
  try {
    return inspectBoundedNodeJson(value);
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

const nodeManifestShape = {
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
  lifecycle: z.enum(['active', 'deprecated', 'migration_required', 'retired']),
  executor: executorIdentitySchema,
  policyReferences: z.array(policyReferenceSchema),
} as const;

export const nodeManifestSchema = z.discriminatedUnion('schemaVersion', [
  z
    .object({
      schemaVersion: z.literal(1),
      ...nodeManifestShape,
      executorAbi: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(2),
      ...nodeManifestShape,
      executorAbi: z.number().int().positive(),
    })
    .strict(),
]);

export function createNodeManifestV2(
  manifest: NodeManifestV1,
  executorAbi: number,
): NodeManifestV2 {
  if (!Number.isSafeInteger(executorAbi) || executorAbi <= 0)
    throw new TypeError('executor ABI must be a positive safe integer');
  if (
    manifest.executorAbi !== undefined &&
    manifest.executorAbi !== executorAbi
  )
    throw new TypeError('executor ABI migration conflicts with manifest');
  return cloneAndFreeze(
    nodeManifestSchema.parse({ ...manifest, schemaVersion: 2, executorAbi }),
  ) as NodeManifestV2;
}

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
  rejectDuplicateIdentities('selected definition', selectedDefinitions);
  return computeSelectionFingerprintFromParsedRelease(
    parsedRelease,
    selectedDefinitions,
  );
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
  if (next.epoch !== previous.epoch + 1)
    throw new Error('compatibility release epoch must be contiguous');
  if (next.fingerprint === previous.fingerprint)
    throw new Error('compatibility release successor must change');

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
