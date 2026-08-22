import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import {
  canonicalCompatibilityReleaseJson,
  computeCompatibilitySelectionFingerprint,
  createRegistryRelease,
  createRegistryReleaseSuccessor,
  NODE_JSON_LIMITS_V1,
  parseRegistryRelease,
  type DefinitionIdentity,
  type ExecutorIdentity,
  type NodeManifest,
  type PolicyReference,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';
import {
  parseWorkflowGraphForPublish,
  type ValueSource,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model/graph';

import { WorkflowEngineError } from './errors.js';
import type { SideEffectClass } from './types.js';

export const PHASE3_RUNTIME_POLICIES_V1 = Object.freeze({
  scheduler: Object.freeze({ key: 'engine.scheduler', version: 1 }),
  checkpoint: Object.freeze({ key: 'engine.checkpoint', version: 1 }),
  retry: Object.freeze({ key: 'engine.retry', version: 1 }),
  timeout: Object.freeze({ key: 'engine.timeout', version: 1 }),
  cancellation: Object.freeze({ key: 'engine.cancellation', version: 1 }),
});
export const WORKFLOW_EXECUTABLE_LIMITS_V2 = Object.freeze({
  bytes: NODE_JSON_LIMITS_V1.bytes,
  depth: NODE_JSON_LIMITS_V1.depth,
  members: NODE_JSON_LIMITS_V1.members,
});

export interface ExecutableRuntimePoliciesV1 {
  readonly scheduler: PolicyReference;
  readonly checkpoint: PolicyReference;
  readonly retry: PolicyReference;
  readonly timeout: PolicyReference;
  readonly cancellation: PolicyReference;
}

export interface WorkflowExecutableNodeV2 {
  readonly id: string;
  readonly definition: DefinitionIdentity;
  readonly configVersion: number;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly inputMappings: Readonly<Record<string, ValueSource>>;
  readonly connectionRefs: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly sideEffectClass: SideEffectClass;
  readonly executor: ExecutorIdentity;
  readonly executorAbi: number;
  readonly policyReferences: readonly PolicyReference[];
}

export interface WorkflowExecutableV2 {
  readonly schemaVersion: 2;
  readonly sourceGraphSchemaVersion: 1;
  readonly graph: {
    readonly settings: WorkflowGraph['settings'];
    readonly nodes: readonly WorkflowExecutableNodeV2[];
    readonly edges: readonly WorkflowEdge[];
  };
  readonly runtimePolicies: ExecutableRuntimePoliciesV1;
  readonly configMigrations: readonly [];
  readonly compatibilitySelectionFingerprint: string;
  readonly compatibilityReleaseEpoch: number;
  readonly compatibilityReleaseFingerprint: string;
}

declare const verifiedExecutableV2: unique symbol;
export type VerifiedWorkflowExecutableV2 = WorkflowExecutableV2 & {
  readonly [verifiedExecutableV2]: true;
};

export interface CompiledWorkflowExecutableV2 {
  readonly envelope: VerifiedWorkflowExecutableV2;
  readonly checksum: `wf:v2:sha256:${string}`;
}
const authenticExecutableIdentities = new WeakSet<object>();

function registerExecutableIdentity(
  value: CompiledWorkflowExecutableV2,
): CompiledWorkflowExecutableV2 {
  authenticExecutableIdentities.add(value);
  return value;
}

export function assertAuthenticExecutableIdentity(
  value: CompiledWorkflowExecutableV2,
): void {
  if (!authenticExecutableIdentities.has(value))
    fail('workflow executable identity was not verified in this process');
}

const token = (
  value: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): string => `${value.key}\u0000${String(value.version)}`;
const compareIdentity = (
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): number =>
  left.key < right.key
    ? -1
    : left.key > right.key
      ? 1
      : left.version - right.version;
const sameIdentity = (
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): boolean => left.key === right.key && left.version === right.version;
const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function fail(message: string): never {
  throw new WorkflowEngineError('executable_invalid', message);
}

function normalizeError(error: unknown): never {
  if (error instanceof WorkflowEngineError) throw error;
  fail(error instanceof Error ? error.message : 'executable processing failed');
}

function freezeExecutable<T extends object>(value: T): T {
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const children = Object.values(current) as unknown[];
    for (const child of children)
      if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(current);
  }
  return value;
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ domain, value }))
    .digest('hex');
}

function globalPolicies(
  policies: ExecutableRuntimePoliciesV1,
): readonly PolicyReference[] {
  return [
    policies.scheduler,
    policies.checkpoint,
    policies.retry,
    policies.timeout,
    policies.cancellation,
  ];
}

function validateGlobals(
  policies: ExecutableRuntimePoliciesV1,
  release: RegistryRelease,
): void {
  const selected = globalPolicies(policies);
  const expected = globalPolicies(PHASE3_RUNTIME_POLICIES_V1);
  if (
    !selected.every((value, index) => {
      const expectedValue = expected[index];
      return expectedValue !== undefined && sameIdentity(value, expectedValue);
    }) ||
    new Set(selected.map(token)).size !== selected.length
  )
    fail('runtime policy selection is not Phase 3 policy v1');
  const available = new Set(release.policies.map(token));
  if (!selected.every((value) => available.has(token(value))))
    fail('compatibility release is missing a runtime policy');
}

export function composeExecutableCompatibilityRelease(
  nodeReleaseInput: unknown,
): RegistryRelease {
  try {
    const nodeRelease = parseRegistryRelease(nodeReleaseInput);
    if (nodeRelease.policies.some(({ key }) => key.startsWith('engine.')))
      fail('node release must not declare engine runtime policies');
    return createRegistryRelease({
      epoch: nodeRelease.epoch,
      definitions: nodeRelease.definitions,
      executors: nodeRelease.executors,
      policies: [
        ...nodeRelease.policies,
        ...globalPolicies(PHASE3_RUNTIME_POLICIES_V1),
      ],
    });
  } catch (error) {
    normalizeError(error);
  }
}

export type ExecutableCompatibilityReleaseDescription = Readonly<{
  epoch: number;
  fingerprint: string;
  catalogJson: string;
}>;

export type ExecutableCompatibilityReleaseSupport = Readonly<{
  descriptions: readonly ExecutableCompatibilityReleaseDescription[];
  resolve(epoch: number, fingerprint: string): RegistryRelease;
}>;

export function describeExecutableCompatibilityRelease(
  releaseInput: unknown,
): ExecutableCompatibilityReleaseDescription {
  try {
    const release = parseRegistryRelease(releaseInput);
    return Object.freeze({
      epoch: release.epoch,
      fingerprint: release.fingerprint,
      catalogJson: canonicalCompatibilityReleaseJson(release),
    });
  } catch (error: unknown) {
    normalizeError(error);
  }
}

export function createExecutableCompatibilityReleaseSupport(
  releaseInputs: readonly unknown[],
): ExecutableCompatibilityReleaseSupport {
  try {
    if (releaseInputs.length < 1 || releaseInputs.length > 2)
      fail('artifact supports only one rolling overlap');
    return createExecutableCompatibilityReleaseHistory(releaseInputs);
  } catch (error: unknown) {
    normalizeError(error);
  }
}

/**
 * Every immutable release whose published workflows remain executable by an
 * artifact. Deployment readiness must use the bounded rolling-support factory
 * above; retained execution history is a separate compatibility concern.
 */
export function createExecutableCompatibilityReleaseHistory(
  releaseInputs: readonly unknown[],
): ExecutableCompatibilityReleaseSupport {
  try {
    if (releaseInputs.length < 1)
      fail('executable compatibility history must not be empty');
    const releases = releaseInputs
      .map(parseRegistryRelease)
      .sort((left, right) => left.epoch - right.epoch);
    if (new Set(releases.map(({ epoch }) => epoch)).size !== releases.length)
      fail('compatibility release epochs must be unique');
    for (let index = 1; index < releases.length; index += 1) {
      const previous = releases[index - 1];
      const target = releases[index];
      if (previous === undefined || target === undefined)
        fail('executable compatibility history is incomplete');
      if (target.epoch !== previous.epoch + 1)
        fail('compatibility release is not the next successor');
      const successor = createRegistryReleaseSuccessor({
        epoch: target.epoch,
        definitions: target.definitions,
        executors: target.executors,
        policies: target.policies,
        previous,
      });
      if (successor.fingerprint !== target.fingerprint)
        fail('compatibility release successor fingerprint changed');
    }
    const byPair = new Map(
      releases.map((release) => [
        `${String(release.epoch)}\u0000${release.fingerprint}`,
        release,
      ]),
    );
    const descriptions = Object.freeze(
      releases.map(describeExecutableCompatibilityRelease),
    );
    return Object.freeze({
      descriptions,
      resolve: (epoch: number, fingerprint: string): RegistryRelease => {
        if (!Number.isInteger(epoch) || epoch < 1)
          fail('compatibility release is not supported by this artifact');
        const release = byPair.get(`${String(epoch)}\u0000${fingerprint}`);
        if (release === undefined)
          fail('compatibility release is not supported by this artifact');
        return release;
      },
    });
  } catch (error: unknown) {
    normalizeError(error);
  }
}

function uniqueDefinitions(
  nodes: readonly Pick<WorkflowExecutableNodeV2, 'definition'>[],
): readonly DefinitionIdentity[] {
  const unique = new Map<string, DefinitionIdentity>();
  for (const { definition } of nodes) unique.set(token(definition), definition);
  return [...unique.values()].sort(compareIdentity);
}

function selectionFingerprint(
  release: RegistryRelease,
  nodes: readonly Pick<WorkflowExecutableNodeV2, 'definition'>[],
  policies: ExecutableRuntimePoliciesV1,
): string {
  const nodeSelectionFingerprint = computeCompatibilitySelectionFingerprint(
    release,
    uniqueDefinitions(nodes),
  );
  return `engine-select:v1:sha256:${digest(
    'pertexo.workflow-executable-selection.v1',
    {
      nodeSelectionFingerprint,
      globalPolicies: [...globalPolicies(policies)].sort(compareIdentity),
      configMigrations: [],
    },
  )}`;
}

function definitionManifest(
  release: RegistryRelease,
  definition: DefinitionIdentity,
): NodeManifest {
  const manifest = release.definitions.find((candidate) =>
    sameIdentity(candidate.definition, definition),
  );
  if (manifest === undefined) fail('node definition is unavailable');
  return manifest;
}

function executorManifest(
  release: RegistryRelease,
  executor: ExecutorIdentity,
) {
  const manifest = release.executors.find((candidate) =>
    sameIdentity(candidate.executor, executor),
  );
  if (manifest === undefined) fail('node executor is unavailable');
  return manifest;
}

function executableNode(
  node: WorkflowNode,
  release: RegistryRelease,
): WorkflowExecutableNodeV2 {
  if (node.structured !== undefined)
    fail('structured nodes are not executable in Phase 3');
  const definition = definitionManifest(release, node.definition);
  const executor = executorManifest(release, definition.executor);
  if (
    (definition.lifecycle !== 'active' &&
      definition.lifecycle !== 'deprecated') ||
    executor.lifecycle !== 'active' ||
    !executor.definitions.some((value) =>
      sameIdentity(value, definition.definition),
    )
  )
    fail('node definition is not publishable');
  if (node.configVersion !== definition.configVersion)
    fail('node config version is incompatible');
  if (
    definition.executorAbi === undefined ||
    definition.executorAbi !== executor.abiVersion
  )
    fail('node executor ABI is incompatible');
  assertExpressionPolicies(node, definition.policyReferences);
  return {
    id: node.id,
    definition: definition.definition,
    configVersion: node.configVersion,
    config: node.config,
    inputMappings: node.inputMappings,
    connectionRefs: node.connectionRefs,
    disabled: node.disabled ?? false,
    sideEffectClass: sideEffectClass(definition.retryClass),
    executor: definition.executor,
    executorAbi: executor.abiVersion,
    policyReferences: [...definition.policyReferences].sort(compareIdentity),
  };
}

function canonicalEdges(graph: WorkflowGraph): readonly WorkflowEdge[] {
  return [...graph.edges].sort((left, right) =>
    compareOrdinal(left.id, right.id),
  );
}

function assertExpressionPolicies(
  node: Pick<WorkflowNode, 'inputMappings'>,
  policies: readonly PolicyReference[],
): void {
  for (const source of Object.values(node.inputMappings))
    if (
      source.kind === 'expression' &&
      !policies.some(
        (policy) =>
          policy.key === 'jsonata.restricted' &&
          policy.version === source.policyVersion,
      )
    )
      fail('expression policy is not pinned by the node definition');
}

function buildBoundary(input: {
  readonly graph: unknown;
  readonly release: unknown;
}): CompiledWorkflowExecutableV2 {
  const release = parseRegistryRelease(input.release);
  validateGlobals(PHASE3_RUNTIME_POLICIES_V1, release);
  const graph = parseWorkflowGraphForPublish(input.graph, {
    schemaVersion: 1,
    definitions: release.definitions.map(({ definition }) => definition),
  });
  const nodes = [...graph.nodes]
    .sort((left, right) => compareOrdinal(left.id, right.id))
    .map((node) => executableNode(node, release));
  const envelope: WorkflowExecutableV2 = {
    schemaVersion: 2,
    sourceGraphSchemaVersion: 1,
    graph: {
      settings: graph.settings,
      nodes,
      edges: canonicalEdges(graph),
    },
    runtimePolicies: PHASE3_RUNTIME_POLICIES_V1,
    configMigrations: [],
    compatibilitySelectionFingerprint: selectionFingerprint(
      release,
      nodes,
      PHASE3_RUNTIME_POLICIES_V1,
    ),
    compatibilityReleaseEpoch: release.epoch,
    compatibilityReleaseFingerprint: release.fingerprint,
  };
  const normalizedEnvelope = freezeExecutable(
    parseBoundary({ envelope, admissionRelease: release }),
  ) as VerifiedWorkflowExecutableV2;
  return registerExecutableIdentity(
    Object.freeze({
      envelope: normalizedEnvelope,
      checksum: computeWorkflowExecutableChecksumV2(normalizedEnvelope),
    }),
  );
}

/**
 * Compiles a graph that the publication use case has already validated against
 * each node's versioned config schema. This module owns executable identity;
 * config-schema execution remains at the injected registry seam.
 */
export function buildWorkflowExecutableV2(input: {
  readonly graph: unknown;
  readonly release: unknown;
}): CompiledWorkflowExecutableV2 {
  try {
    return buildBoundary(input);
  } catch (error) {
    normalizeError(error);
  }
}

function executableProjection(envelope: WorkflowExecutableV2): unknown {
  return {
    schemaVersion: envelope.schemaVersion,
    sourceGraphSchemaVersion: envelope.sourceGraphSchemaVersion,
    graph: envelope.graph,
    runtimePolicies: envelope.runtimePolicies,
    configMigrations: envelope.configMigrations,
    compatibilitySelectionFingerprint:
      envelope.compatibilitySelectionFingerprint,
  };
}

export function computeWorkflowExecutableChecksumV2(
  envelope: WorkflowExecutableV2,
): `wf:v2:sha256:${string}` {
  return `wf:v2:sha256:${digest(
    'pertexo.workflow-executable.v2',
    executableProjection(envelope),
  )}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  )
    fail('executable envelope contains missing or unknown fields');
}

function assertSafeExecutableJson(value: unknown): void {
  type Frame =
    | {
        readonly kind: 'value';
        readonly value: unknown;
        readonly depth: number;
      }
    | { readonly kind: 'exit'; readonly value: object };
  const pending: Frame[] = [{ kind: 'value', value, depth: 1 }];
  const ancestors = new Set<object>();
  let members = 0;
  let bytes = 0;
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > WORKFLOW_EXECUTABLE_LIMITS_V2.bytes)
      fail('executable envelope exceeds maximum bytes');
  };
  const addString = (input: string): void => {
    add(2);
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (
        code === 0x22 ||
        code === 0x5c ||
        code === 0x08 ||
        code === 0x0c ||
        code === 0x0a ||
        code === 0x0d ||
        code === 0x09
      )
        add(2);
      else if (code <= 0x1f) add(6);
      else if (code <= 0x7f) add(1);
      else if (code <= 0x7ff) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          index += 1;
        } else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  };
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }
    const item = frame.value;
    if (item === null) {
      add(4);
      continue;
    }
    if (typeof item === 'string') {
      addString(item);
      continue;
    }
    if (typeof item === 'boolean') {
      add(item ? 4 : 5);
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      add(Object.is(item, -0) ? 1 : String(item).length);
      continue;
    }
    if (typeof item !== 'object') fail('executable envelope must contain JSON');
    if (nodeTypes.isProxy(item))
      fail('executable envelope must not contain proxies');
    if (frame.depth > NODE_JSON_LIMITS_V1.depth)
      fail('executable envelope exceeds maximum depth');
    if (ancestors.has(item))
      fail('executable envelope must not contain cycles');
    const isArray = Array.isArray(item);
    const prototype: object | null = Object.getPrototypeOf(item) as
      object | null;
    if (!isArray && prototype !== Object.prototype && prototype !== null)
      fail('executable envelope must contain plain objects');
    if (isArray && item.length > NODE_JSON_LIMITS_V1.members)
      fail('executable envelope array is oversized');
    add(2 + (isArray ? Math.max(0, item.length - 1) : 0));
    ancestors.add(item);
    pending.push({ kind: 'exit', value: item });
    let enumerableCount = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key))
        fail('executable envelope has inherited enumerable fields');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      )
        fail('executable envelope must contain own data fields');
      members += 1;
      if (members > NODE_JSON_LIMITS_V1.members)
        fail('executable envelope exceeds maximum members');
      if (isArray && key !== String(enumerableCount))
        fail('executable envelope array is sparse or has extra fields');
      if (!isArray) {
        if (enumerableCount > 0) add(1);
        addString(key);
        add(1);
      }
      enumerableCount += 1;
      pending.push({
        kind: 'value',
        value: descriptor.value,
        depth: frame.depth + 1,
      });
    }
    const ownNames = Object.getOwnPropertyNames(item);
    if (Object.getOwnPropertySymbols(item).length !== 0)
      fail('executable envelope has symbol fields');
    if (
      (isArray &&
        (enumerableCount !== item.length ||
          ownNames.length !== item.length + 1 ||
          !ownNames.includes('length'))) ||
      (!isArray && ownNames.length !== enumerableCount)
    )
      fail('executable envelope has hidden or sparse fields');
  }
}

export function normalizeBoundedEngineJson(value: unknown): JsonValue {
  assertSafeExecutableJson(value);
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function parseIdentity(value: unknown, label: string): DefinitionIdentity {
  const identity = record(value, label);
  exactKeys(identity, ['key', 'version']);
  if (
    typeof identity.key !== 'string' ||
    !/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/u.test(identity.key) ||
    typeof identity.version !== 'number' ||
    !Number.isSafeInteger(identity.version) ||
    identity.version < 1
  )
    fail(`${label} is invalid`);
  return { key: identity.key, version: identity.version };
}

function parseGlobals(value: unknown): ExecutableRuntimePoliciesV1 {
  const policies = record(value, 'runtime policies');
  exactKeys(policies, [
    'scheduler',
    'checkpoint',
    'retry',
    'timeout',
    'cancellation',
  ]);
  return {
    scheduler: parseIdentity(policies.scheduler, 'scheduler policy'),
    checkpoint: parseIdentity(policies.checkpoint, 'checkpoint policy'),
    retry: parseIdentity(policies.retry, 'retry policy'),
    timeout: parseIdentity(policies.timeout, 'timeout policy'),
    cancellation: parseIdentity(policies.cancellation, 'cancellation policy'),
  };
}

function parsePolicies(value: unknown): readonly PolicyReference[] {
  if (!Array.isArray(value)) fail('node policies must be an array');
  const policies = value.map((item) => parseIdentity(item, 'node policy'));
  if (new Set(policies.map(token)).size !== policies.length)
    fail('node policies contain duplicates');
  return [...policies].sort(compareIdentity);
}

function parseSideEffectClass(value: unknown): SideEffectClass {
  switch (value) {
    case 'safe':
    case 'idempotent_with_key':
    case 'unsafe':
      return value;
    default:
      fail('node side-effect class is invalid');
  }
}

function sideEffectClass(
  retryClass: NodeManifest['retryClass'],
): SideEffectClass {
  switch (retryClass) {
    case 'safe':
      return 'safe';
    case 'idempotent-with-key':
      return 'idempotent_with_key';
    case 'unsafe':
      return 'unsafe';
    default:
      return unreachableRetryClass(retryClass);
  }
}

function unreachableRetryClass(value: never): never {
  fail(`unsupported retry class ${String(value)}`);
}

function immutableDefinitionBehavior(manifest: NodeManifest): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    definition: manifest.definition,
    family: manifest.family,
    configVersion: manifest.configVersion,
    configSchema: manifest.configSchema,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    ports: {
      inputs: [...manifest.ports.inputs].sort(compareOrdinal),
      outputs: [...manifest.ports.outputs].sort(compareOrdinal),
    },
    credentialRequirements: [...manifest.credentialRequirements].sort(
      compareOrdinal,
    ),
    connectionRequirements: [...manifest.connectionRequirements].sort(
      compareOrdinal,
    ),
    retryClass: manifest.retryClass,
    resourceClass: manifest.resourceClass,
    capabilities: [...manifest.capabilities].sort(compareOrdinal),
    executor: manifest.executor,
    executorAbi: manifest.executorAbi,
    policyReferences: [...manifest.policyReferences].sort(compareIdentity),
  };
}

function immutableExecutorBehavior(
  manifest: RegistryRelease['executors'][number],
): unknown {
  return {
    executor: manifest.executor,
    abiVersion: manifest.abiVersion,
    definitions: [...manifest.definitions].sort(compareIdentity),
    policyReferences: [...manifest.policyReferences].sort(compareIdentity),
  };
}

function authoringNode(raw: Record<string, unknown>): unknown {
  return {
    id: raw.id,
    definition: raw.definition,
    position: { x: 0, y: 0 },
    configVersion: raw.configVersion,
    config: raw.config,
    inputMappings: raw.inputMappings,
    connectionRefs: raw.connectionRefs,
    disabled: raw.disabled,
  };
}

function validatePin(
  raw: Record<string, unknown>,
  node: WorkflowNode,
  admission: RegistryRelease,
  current: RegistryRelease,
  alreadyAdmitted: boolean,
): WorkflowExecutableNodeV2 {
  const definition = parseIdentity(raw.definition, 'node definition');
  const executor = parseIdentity(raw.executor, 'node executor');
  const policies = parsePolicies(raw.policyReferences);
  const selectedSideEffectClass = parseSideEffectClass(raw.sideEffectClass);
  const admissionDefinition = definitionManifest(admission, definition);
  const currentDefinition = definitionManifest(current, definition);
  const admissionExecutor = executorManifest(admission, executor);
  const currentExecutor = executorManifest(current, executor);
  const expectedPolicies = canonicalJson(policies);
  if (
    (admissionDefinition.lifecycle !== 'active' &&
      admissionDefinition.lifecycle !== 'deprecated') ||
    admissionExecutor.lifecycle !== 'active' ||
    canonicalJson(immutableDefinitionBehavior(admissionDefinition)) !==
      canonicalJson(immutableDefinitionBehavior(currentDefinition)) ||
    canonicalJson(immutableExecutorBehavior(admissionExecutor)) !==
      canonicalJson(immutableExecutorBehavior(currentExecutor)) ||
    !sameIdentity(node.definition, definition) ||
    !sameIdentity(admissionDefinition.executor, executor) ||
    !sameIdentity(currentDefinition.executor, executor) ||
    admissionDefinition.configVersion !== node.configVersion ||
    currentDefinition.configVersion !== node.configVersion ||
    raw.executorAbi !== admissionExecutor.abiVersion ||
    raw.executorAbi !== currentExecutor.abiVersion ||
    selectedSideEffectClass !==
      sideEffectClass(admissionDefinition.retryClass) ||
    selectedSideEffectClass !== sideEffectClass(currentDefinition.retryClass) ||
    expectedPolicies !==
      canonicalJson(
        [...admissionDefinition.policyReferences].sort(compareIdentity),
      ) ||
    expectedPolicies !==
      canonicalJson(
        [...currentDefinition.policyReferences].sort(compareIdentity),
      ) ||
    !currentExecutor.definitions.some((value) =>
      sameIdentity(value, definition),
    ) ||
    !(
      currentExecutor.lifecycle === 'active' ||
      currentExecutor.lifecycle === 'retained' ||
      (currentExecutor.lifecycle === 'retirement_blocked' && alreadyAdmitted)
    )
  )
    fail('node executable pins are incompatible');
  assertExpressionPolicies(node, policies);
  return {
    id: node.id,
    definition,
    configVersion: node.configVersion,
    config: node.config,
    inputMappings: node.inputMappings,
    connectionRefs: node.connectionRefs,
    disabled: node.disabled ?? false,
    sideEffectClass: selectedSideEffectClass,
    executor,
    executorAbi: admissionExecutor.abiVersion,
    policyReferences: policies,
  };
}

function parseBoundary(input: {
  readonly envelope: unknown;
  readonly admissionRelease: unknown;
  readonly currentRelease?: unknown;
  readonly execution?: { readonly alreadyAdmitted: boolean };
}): WorkflowExecutableV2 {
  assertSafeExecutableJson(input.envelope);
  const normalizedEnvelope: unknown = normalizeBoundedEngineJson(
    input.envelope,
  );
  const envelope = record(normalizedEnvelope, 'executable envelope');
  exactKeys(envelope, [
    'schemaVersion',
    'sourceGraphSchemaVersion',
    'graph',
    'runtimePolicies',
    'configMigrations',
    'compatibilitySelectionFingerprint',
    'compatibilityReleaseEpoch',
    'compatibilityReleaseFingerprint',
  ]);
  if (envelope.schemaVersion !== 2 || envelope.sourceGraphSchemaVersion !== 1)
    fail('unsupported executable schema version');
  const admission = parseRegistryRelease(input.admissionRelease);
  const current = parseRegistryRelease(
    input.currentRelease ?? input.admissionRelease,
  );
  let alreadyAdmitted = false;
  if (input.execution !== undefined) {
    assertSafeExecutableJson(input.execution);
    const normalizedExecution: unknown = normalizeBoundedEngineJson(
      input.execution,
    );
    const execution = record(normalizedExecution, 'execution context');
    exactKeys(execution, ['alreadyAdmitted']);
    if (typeof execution.alreadyAdmitted !== 'boolean')
      fail('execution alreadyAdmitted must be boolean');
    alreadyAdmitted = execution.alreadyAdmitted;
  }
  if (
    envelope.compatibilityReleaseEpoch !== admission.epoch ||
    envelope.compatibilityReleaseFingerprint !== admission.fingerprint
  )
    fail('executable admission provenance does not match');
  const runtimePolicies = parseGlobals(envelope.runtimePolicies);
  validateGlobals(runtimePolicies, admission);
  validateGlobals(runtimePolicies, current);
  if (
    !Array.isArray(envelope.configMigrations) ||
    envelope.configMigrations.length
  )
    fail('Phase 3 config migrations must be empty');
  const rawGraph = record(envelope.graph, 'executable graph');
  exactKeys(rawGraph, ['settings', 'nodes', 'edges']);
  if (!Array.isArray(rawGraph.nodes)) fail('executable nodes must be an array');
  const rawNodes = rawGraph.nodes.map((value, index) => {
    const node = record(value, `executable node ${String(index)}`);
    exactKeys(node, [
      'id',
      'definition',
      'configVersion',
      'config',
      'inputMappings',
      'connectionRefs',
      'disabled',
      'sideEffectClass',
      'executor',
      'executorAbi',
      'policyReferences',
    ]);
    return node;
  });
  const graph = parseWorkflowGraphForPublish(
    {
      schemaVersion: 1,
      settings: rawGraph.settings,
      nodes: rawNodes.map(authoringNode),
      edges: rawGraph.edges,
    },
    {
      schemaVersion: 1,
      definitions: admission.definitions.map(({ definition }) => definition),
    },
  );
  const parsedById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes = rawNodes.map((raw) => {
    if (typeof raw.id !== 'string') fail('node ID is invalid');
    const node = parsedById.get(raw.id);
    if (node === undefined) fail('node is absent from parsed graph');
    return validatePin(raw, node, admission, current, alreadyAdmitted);
  });
  const sortedNodes = [...nodes].sort((left, right) =>
    compareOrdinal(left.id, right.id),
  );
  const sortedEdges = canonicalEdges(graph);
  if (
    canonicalJson(nodes) !== canonicalJson(sortedNodes) ||
    canonicalJson(graph.edges) !== canonicalJson(sortedEdges)
  )
    fail('executable graph is not canonically ordered');
  const expectedSelection = selectionFingerprint(
    admission,
    nodes,
    runtimePolicies,
  );
  if (envelope.compatibilitySelectionFingerprint !== expectedSelection)
    fail('compatibility selection fingerprint does not match');
  return {
    schemaVersion: 2,
    sourceGraphSchemaVersion: 1,
    graph: { settings: graph.settings, nodes, edges: sortedEdges },
    runtimePolicies,
    configMigrations: [],
    compatibilitySelectionFingerprint: expectedSelection,
    compatibilityReleaseEpoch: admission.epoch,
    compatibilityReleaseFingerprint: admission.fingerprint,
  };
}

export function parseWorkflowExecutableV2(input: {
  readonly envelope: unknown;
  readonly admissionRelease: unknown;
  readonly currentRelease?: unknown;
  readonly execution?: { readonly alreadyAdmitted: boolean };
}): VerifiedWorkflowExecutableV2 {
  try {
    return freezeExecutable(
      parseBoundary(input),
    ) as VerifiedWorkflowExecutableV2;
  } catch (error) {
    normalizeError(error);
  }
}

export function verifyWorkflowExecutableV2(input: {
  readonly envelope: unknown;
  readonly checksum: unknown;
  readonly admissionRelease: unknown;
  readonly currentRelease?: unknown;
  readonly execution?: { readonly alreadyAdmitted: boolean };
}): CompiledWorkflowExecutableV2 {
  const envelope = parseWorkflowExecutableV2(input);
  const checksum = computeWorkflowExecutableChecksumV2(envelope);
  if (input.checksum !== checksum)
    fail('workflow executable V2 checksum does not match');
  return registerExecutableIdentity(Object.freeze({ envelope, checksum }));
}
