import './server-only.js';

import { z, type ZodType } from 'zod';

import type {
  NodeDefinitionRegistration,
  NodeExecutionRequest,
  NodeExecutionResult,
  NodeExecutionRuntime,
  NodeExecutorRegistration,
  NodeRegistryOptions,
} from './executor-contracts.js';
import {
  DefinitionNotFoundError,
  ExecutorNotFoundError,
  InvalidBoundedJsonError,
  NodeConfigValidationError,
  NodeDispatchEvidenceError,
  NodeExecutionAbortedError,
  NodeExecutionRuntimeRequiredError,
  NodeInputValidationError,
  NodeOutputValidationError,
  NodeRegistryCompatibilityError,
  type NodeSdkError,
} from './executor-errors.js';
import { canonicalizeBoundedJson, isJsonObject } from './json-boundary.js';

import {
  type DefinitionIdentity,
  definitionIdentitySchema,
  type DefinitionLifecycle,
  type ExecutorIdentity,
  executorIdentitySchema,
  type ExecutorLifecycle,
  type ExecutorManifest,
  type NodeManifest,
  nodeManifestSchema,
  type PolicyReference,
  type RegistryRelease,
  generateSchemaDocument,
  parseRegistryRelease,
  TERMINATES_RUN_CAPABILITY,
} from './release.js';

export type {
  JsonValue,
  NodeArtifactReference,
  NodeArtifactRuntime,
  NodeConnectionRuntime,
  NodeDefinitionRegistration,
  NodeExecutionInvocation,
  NodeExecutionKind,
  NodeExecutionRequest,
  NodeExecutionResult,
  NodeExecutionRuntime,
  NodeExecutorRegistration,
  NodeRegistryOptions,
  NodeSideEffectClass,
  ResolvedNodeConnection,
} from './executor-contracts.js';
export {
  DefinitionNotFoundError,
  ExecutorNotFoundError,
  InvalidBoundedJsonError,
  NodeConfigValidationError,
  NodeDispatchEvidenceError,
  NodeExecutionAbortedError,
  NodeExecutionRuntimeRequiredError,
  NodeExecutorFailure,
  NodeInputValidationError,
  NodeOutputValidationError,
  NodeRegistryCompatibilityError,
  NodeSdkError,
  ProviderExecutionRateLimitError,
  type NodeErrorCode,
  type NodeExecutorErrorKind,
  type NodeExecutorFailureOutcome,
} from './executor-errors.js';
export {
  canonicalizeBoundedJson,
  NODE_EXECUTION_LIMITS_V1,
} from './json-boundary.js';

export const DISPATCH_AWARE_EXECUTOR_ABI_VERSION = 2 as const;
const SUPPORTED_EXECUTOR_ABI_VERSIONS = new Set<number>([
  1,
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
]);

interface PinnedNodeDefinition {
  readonly manifest: NodeManifest;
  readonly configSchema: ZodType;
  readonly inputSchema: ZodType;
  readonly outputSchema: ZodType;
}

interface PinnedNodeExecutor {
  readonly manifest: ExecutorManifest;
  readonly registration: NodeExecutorRegistration;
}

export interface NodeDefinitionCatalog {
  readonly schemaVersion: 1;
  readonly definitions: readonly DefinitionIdentity[];
}

export interface NodeRegistry {
  readonly compatibility: Readonly<{
    readonly epoch: number;
    readonly fingerprint: string;
  }>;
  readonly placementCatalog: () => NodeDefinitionCatalog;
  readonly publicationCatalog: () => NodeDefinitionCatalog;
  readonly historicalCatalog: () => NodeDefinitionCatalog;
  readonly dispatchMode: (
    request: Pick<NodeExecutionRequest, 'definition' | 'executor'>,
  ) => 'before_execute' | 'executor_controlled';
  readonly execute: (
    request: NodeExecutionRequest,
  ) => Promise<NodeExecutionResult>;
}

const connectionRefsSchema = z
  .record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u), z.uuid())
  .refine((value) => Object.keys(value).length <= 16)
  .transform((value) => Object.freeze({ ...value }));

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

function sameIdentity(
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameIdentitySet(
  left: readonly (DefinitionIdentity | ExecutorIdentity | PolicyReference)[],
  right: readonly (DefinitionIdentity | ExecutorIdentity | PolicyReference)[],
): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort(compareIdentity);
  const normalizedRight = [...right].sort(compareIdentity);
  return normalizedLeft.every((identity, index) => {
    const candidate = normalizedRight[index];
    return candidate !== undefined && sameIdentity(identity, candidate);
  });
}

function stableComparable(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableComparable);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, stableComparable(item)]),
  );
}

function sameManifest(left: NodeManifest, right: NodeManifest): boolean {
  return (
    JSON.stringify(stableComparable(left)) ===
    JSON.stringify(stableComparable(right))
  );
}

function validateUnique(
  label: string,
  identities: readonly (
    DefinitionIdentity | ExecutorIdentity | PolicyReference
  )[],
): void {
  const seen = new Set<string>();
  for (const identity of identities) {
    const token = identityToken(identity);
    if (seen.has(token))
      throw new NodeRegistryCompatibilityError(
        `duplicate ${label} identity ${identity.key}@${String(identity.version)}`,
      );
    seen.add(token);
  }
}

function mapSchemaError(
  error: unknown,
  kind: 'config' | 'input' | 'output',
): NodeSdkError {
  if (kind === 'config') return new NodeConfigValidationError(error);
  if (kind === 'input') return new NodeInputValidationError(error);
  return new NodeOutputValidationError(error);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new NodeExecutionAbortedError();
}

function validateDefinitionRegistration(
  registration: NodeDefinitionRegistration,
  release: RegistryRelease,
): PinnedNodeDefinition {
  const parsed = nodeManifestSchema.parse(registration.manifest);
  const releaseManifest = release.definitions.find((candidate) =>
    sameIdentity(candidate.definition, parsed.definition),
  );
  if (releaseManifest === undefined || !sameManifest(releaseManifest, parsed))
    throw new NodeRegistryCompatibilityError(
      `definition ${parsed.definition.key}@${String(parsed.definition.version)} does not match the release`,
    );
  const schemaDocuments = [
    ['config', parsed.configSchema, registration.configSchema],
    ['input', parsed.inputSchema, registration.inputSchema],
    ['output', parsed.outputSchema, registration.outputSchema],
  ] as const;
  for (const [label, documented, runtime] of schemaDocuments) {
    const generated = generateSchemaDocument(runtime);
    if (
      JSON.stringify(stableComparable(documented)) !==
      JSON.stringify(stableComparable(generated))
    )
      throw new NodeRegistryCompatibilityError(
        `${label} JSON Schema projection does not match the registered Zod schema projection`,
      );
  }
  return {
    manifest: parsed,
    configSchema: registration.configSchema,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
  };
}

export function createNodeRegistry(options: NodeRegistryOptions): NodeRegistry {
  let release: RegistryRelease;
  try {
    release = parseRegistryRelease(options.release);
  } catch (error) {
    throw new NodeRegistryCompatibilityError('invalid registry release', {
      cause: error instanceof Error ? error.message : 'unknown',
    });
  }
  validateUnique(
    'definition',
    options.definitions.map(({ manifest }) => manifest.definition),
  );
  validateUnique(
    'executor',
    options.executors.map(({ executor }) => executor),
  );
  validateUnique(
    'release definition',
    release.definitions.map(({ definition }) => definition),
  );
  validateUnique(
    'release executor',
    release.executors.map(({ executor }) => executor),
  );
  validateUnique('release policy', release.policies);
  const pinnedDefinitions = options.definitions.map((definition) =>
    validateDefinitionRegistration(definition, release),
  );
  const definitionMap = new Map(
    pinnedDefinitions.map((definition) => [
      identityToken(definition.manifest.definition),
      definition,
    ]),
  );
  const executorMap = new Map<string, PinnedNodeExecutor>();
  for (const registration of options.executors) {
    const parsedExecutor = executorIdentitySchema.parse(registration.executor);
    if (!SUPPORTED_EXECUTOR_ABI_VERSIONS.has(registration.abiVersion))
      throw new NodeRegistryCompatibilityError(
        `executor ${parsedExecutor.key}@${String(parsedExecutor.version)} uses unsupported ABI ${String(registration.abiVersion)}`,
      );
    if (executorMap.has(identityToken(parsedExecutor)))
      throw new NodeRegistryCompatibilityError(
        `duplicate executor identity ${parsedExecutor.key}@${String(parsedExecutor.version)}`,
      );
    const releaseExecutor = release.executors.find((candidate) =>
      sameIdentity(candidate.executor, parsedExecutor),
    );
    if (releaseExecutor === undefined)
      throw new NodeRegistryCompatibilityError(
        `executor ${parsedExecutor.key}@${String(parsedExecutor.version)} is not in the release`,
      );
    if (
      releaseExecutor.abiVersion !== registration.abiVersion ||
      releaseExecutor.lifecycle !== registration.lifecycle ||
      !sameIdentitySet(releaseExecutor.definitions, registration.definitions) ||
      !sameIdentitySet(
        releaseExecutor.policyReferences,
        registration.policyReferences,
      )
    )
      throw new NodeRegistryCompatibilityError(
        `executor ${parsedExecutor.key}@${String(parsedExecutor.version)} does not match the release`,
      );
    for (const definition of registration.definitions) {
      if (!definitionMap.has(identityToken(definition)))
        throw new NodeRegistryCompatibilityError(
          `executor ${parsedExecutor.key}@${String(parsedExecutor.version)} declares an unknown definition`,
        );
    }
    executorMap.set(identityToken(parsedExecutor), {
      manifest: releaseExecutor,
      registration: Object.freeze({
        abiVersion: registration.abiVersion,
        definitions: Object.freeze(
          registration.definitions.map((identity) =>
            Object.freeze({ ...identity }),
          ),
        ),
        executor: Object.freeze({ ...parsedExecutor }),
        lifecycle: registration.lifecycle,
        policyReferences: Object.freeze(
          registration.policyReferences.map((identity) =>
            Object.freeze({ ...identity }),
          ),
        ),
        execute: registration.execute,
      }),
    });
  }
  for (const manifest of release.definitions) {
    const definition = definitionMap.get(identityToken(manifest.definition));
    if (definition === undefined)
      throw new NodeRegistryCompatibilityError(
        `release definition ${manifest.definition.key}@${String(manifest.definition.version)} has no server schema registration`,
      );
    const executor = executorMap.get(identityToken(manifest.executor));
    if (executor === undefined)
      throw new NodeRegistryCompatibilityError(
        `definition ${manifest.definition.key}@${String(manifest.definition.version)} has no exact executor registration`,
      );
    const executorManifest = release.executors.find((candidate) =>
      sameIdentity(candidate.executor, manifest.executor),
    );
    if (executorManifest === undefined)
      throw new NodeRegistryCompatibilityError(
        `executor ${manifest.executor.key}@${String(manifest.executor.version)} does not declare definition ${manifest.definition.key}@${String(manifest.definition.version)}`,
      );
    if (
      !executorManifest.definitions.some((candidate) =>
        sameIdentity(candidate, manifest.definition),
      )
    )
      throw new NodeRegistryCompatibilityError(
        `executor ${manifest.executor.key}@${String(manifest.executor.version)} does not declare definition ${manifest.definition.key}@${String(manifest.definition.version)}`,
      );
    if (
      manifest.executorAbi !== undefined &&
      manifest.executorAbi !== executor.registration.abiVersion
    )
      throw new NodeRegistryCompatibilityError(
        `definition ${manifest.definition.key}@${String(manifest.definition.version)} requires an incompatible executor ABI`,
      );
    if (
      !sameIdentitySet(
        manifest.policyReferences,
        executor.registration.policyReferences,
      )
    )
      throw new NodeRegistryCompatibilityError(
        `definition ${manifest.definition.key}@${String(manifest.definition.version)} has incompatible policy references`,
      );
    if (
      executor.registration.lifecycle === 'retired' ||
      executor.registration.lifecycle === 'staged'
    )
      throw new NodeRegistryCompatibilityError(
        `executor ${manifest.executor.key}@${String(manifest.executor.version)} cannot execute this release`,
      );
    void definition;
  }
  const catalog = (
    include: (manifest: NodeManifest, executor: ExecutorManifest) => boolean,
  ): NodeDefinitionCatalog => ({
    schemaVersion: 1,
    definitions: Object.freeze(
      [...release.definitions]
        .filter((manifest) => {
          const executor = release.executors.find((candidate) =>
            sameIdentity(candidate.executor, manifest.executor),
          );
          return executor !== undefined && include(manifest, executor);
        })
        .map(({ definition }) => ({ ...definition }))
        .sort(compareIdentity),
    ),
  });
  const placementCatalog = (): NodeDefinitionCatalog =>
    catalog(
      (manifest, executor) =>
        manifest.lifecycle === 'active' && executor.lifecycle === 'active',
    );
  const publicationCatalog = (): NodeDefinitionCatalog =>
    catalog(
      (manifest, executor) =>
        (manifest.lifecycle === 'active' ||
          manifest.lifecycle === 'deprecated') &&
        executor.lifecycle === 'active',
    );
  const historicalCatalog = (): NodeDefinitionCatalog => catalog(() => true);
  const resolveDefinition = (
    definition: DefinitionIdentity,
  ): PinnedNodeDefinition => {
    const parsed = definitionIdentitySchema.parse(definition);
    const resolved = definitionMap.get(identityToken(parsed));
    if (resolved === undefined) throw new DefinitionNotFoundError(parsed);
    return resolved;
  };
  const resolveExecutor = (executor: ExecutorIdentity): PinnedNodeExecutor => {
    const parsed = executorIdentitySchema.parse(executor);
    const pinned = executorMap.get(identityToken(parsed));
    if (pinned === undefined) throw new ExecutorNotFoundError(parsed);
    return pinned;
  };
  const dispatchMode = (
    request: Pick<NodeExecutionRequest, 'definition' | 'executor'>,
  ): 'before_execute' | 'executor_controlled' => {
    const executor = resolveExecutor(request.executor);
    const definition = resolveDefinition(request.definition);
    if (!sameIdentity(definition.manifest.executor, request.executor))
      throw new NodeRegistryCompatibilityError(
        `definition ${request.definition.key}@${String(request.definition.version)} is not bound to executor ${request.executor.key}@${String(request.executor.version)}`,
      );
    return executor.registration.abiVersion ===
      DISPATCH_AWARE_EXECUTOR_ABI_VERSION
      ? 'executor_controlled'
      : 'before_execute';
  };
  const execute = async (
    request: NodeExecutionRequest,
  ): Promise<NodeExecutionResult> => {
    assertNotAborted(request.signal);
    const executor = resolveExecutor(request.executor);
    const definition = resolveDefinition(request.definition);
    if (!sameIdentity(definition.manifest.executor, request.executor))
      throw new NodeRegistryCompatibilityError(
        `definition ${request.definition.key}@${String(request.definition.version)} is not bound to executor ${request.executor.key}@${String(request.executor.version)}`,
      );
    const bounded = canonicalizeBoundedJson({
      config: request.config,
      input: request.input,
      connectionRefs: request.connectionRefs ?? {},
    });
    if (!isJsonObject(bounded))
      throw new InvalidBoundedJsonError('execution envelope is not an object');
    let config: unknown;
    let input: unknown;
    let connectionRefs: Readonly<Record<string, string>>;
    try {
      config = definition.configSchema.parse(bounded.config);
    } catch (error) {
      throw mapSchemaError(error, 'config');
    }
    try {
      input = definition.inputSchema.parse(bounded.input);
    } catch (error) {
      throw mapSchemaError(error, 'input');
    }
    try {
      connectionRefs = connectionRefsSchema.parse(bounded.connectionRefs);
    } catch (error) {
      throw mapSchemaError(error, 'config');
    }
    const dispatchAware =
      executor.registration.abiVersion === DISPATCH_AWARE_EXECUTOR_ABI_VERSION;
    if (dispatchAware && request.runtime === undefined)
      throw new NodeExecutionRuntimeRequiredError();
    const dispatchState: {
      value: 'unused' | 'in_flight' | 'committed' | 'failed';
    } = { value: 'unused' };
    const runtime =
      request.runtime === undefined
        ? undefined
        : Object.freeze({
            ...request.runtime,
            beforeDispatch: async (
              input?: Parameters<NodeExecutionRuntime['beforeDispatch']>[0],
            ): Promise<void> => {
              if (dispatchState.value !== 'unused')
                throw new NodeDispatchEvidenceError('duplicate_dispatch');
              dispatchState.value = 'in_flight';
              try {
                await request.runtime?.beforeDispatch(input);
                dispatchState.value = 'committed';
              } catch (error) {
                dispatchState.value = 'failed';
                throw error;
              }
            },
          });
    const result = await executor.registration.execute({
      config,
      input,
      connectionRefs,
      signal: request.signal,
      ...(runtime === undefined ? {} : { runtime }),
    });
    if (dispatchAware && dispatchState.value !== 'committed')
      throw new NodeDispatchEvidenceError('dispatch_evidence_missing');
    let output: unknown;
    try {
      output = definition.outputSchema.parse(canonicalizeBoundedJson(result));
    } catch (error) {
      throw mapSchemaError(error, 'output');
    }
    return {
      kind: definition.manifest.capabilities.includes(TERMINATES_RUN_CAPABILITY)
        ? 'terminal_success'
        : 'succeeded',
      output: canonicalizeBoundedJson(output),
    };
  };
  return Object.freeze({
    compatibility: Object.freeze({
      epoch: release.epoch,
      fingerprint: release.fingerprint,
    }),
    placementCatalog,
    publicationCatalog,
    historicalCatalog,
    dispatchMode,
    execute,
  });
}

export type { DefinitionLifecycle, ExecutorLifecycle };
