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
import { assertDefinitionExecutorBinding } from './registry-binding.js';
export { bindNodeCatalog } from './registry-binding.js';

import {
  type DefinitionIdentity,
  definitionIdentitySchema,
  type ExecutorIdentity,
  executorIdentitySchema,
  type ExecutorManifest,
  type NodeManifest,
  nodeManifestSchema,
  type PolicyReference,
  type NodeCatalog,
  generateSchemaDocument,
  parseNodeCatalog,
  TERMINATES_RUN_CAPABILITY,
} from './catalog.js';

export type {
  JsonValue,
  NodeArtifactReference,
  NodeArtifactRuntime,
  NodeConnectionRuntime,
  NodeConnectionHealthObservation,
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
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
  type NodeErrorCode,
  type NodeExecutorErrorKind,
  type NodeExecutorFailureOutcome,
} from './executor-errors.js';
export {
  canonicalizeBoundedJson,
  NODE_EXECUTION_LIMITS_V1,
} from './json-boundary.js';
import { compareIdentity, identityToken, sameIdentity } from './identity.js';

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

interface PinnedRegistrations {
  readonly definitionMap: ReadonlyMap<string, PinnedNodeDefinition>;
  readonly executorMap: ReadonlyMap<string, PinnedNodeExecutor>;
}

export interface NodeRegistry {
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

function runtimeSchemaComparable(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return stableComparable(value);
  const structuralProjection = { ...(value as Record<string, unknown>) };
  delete structuralProjection['x-pertexo-runtime-only-semantics'];
  return stableComparable(structuralProjection);
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

function safeNodeCatalogFailureCause(error: unknown): string {
  try {
    if (!(error instanceof Error)) return 'unknown';
    return typeof error.message === 'string' ? error.message : 'unknown';
  } catch {
    return 'unknown';
  }
}

function validateDefinitionRegistration(
  registration: NodeDefinitionRegistration,
  catalog: NodeCatalog,
): PinnedNodeDefinition {
  const parsed = nodeManifestSchema.parse(registration.manifest);
  const catalogManifest = catalog.definitions.find((candidate) =>
    sameIdentity(candidate.definition, parsed.definition),
  );
  if (catalogManifest === undefined || !sameManifest(catalogManifest, parsed))
    throw new NodeRegistryCompatibilityError(
      `definition ${parsed.definition.key}@${String(parsed.definition.version)} does not match the catalog`,
    );
  const schemaDocuments = [
    ['config', parsed.configSchema, registration.configSchema],
    ['input', parsed.inputSchema, registration.inputSchema],
    ['output', parsed.outputSchema, registration.outputSchema],
  ] as const;
  for (const [label, documented, runtime] of schemaDocuments) {
    const generated = generateSchemaDocument(runtime);
    if (
      JSON.stringify(runtimeSchemaComparable(documented)) !==
      JSON.stringify(runtimeSchemaComparable(generated))
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

function pinRegistrations(
  catalog: NodeCatalog,
  options: Pick<NodeRegistryOptions, 'definitions' | 'executors'>,
): PinnedRegistrations {
  validateUnique(
    'definition',
    options.definitions.map(({ manifest }) => manifest.definition),
  );
  validateUnique(
    'executor',
    options.executors.map(({ executor }) => executor),
  );
  validateUnique(
    'catalog definition',
    catalog.definitions.map(({ definition }) => definition),
  );
  validateUnique(
    'catalog executor',
    catalog.executors.map(({ executor }) => executor),
  );
  validateUnique('catalog policy', catalog.policies);

  const pinnedDefinitions = options.definitions.map((definition) =>
    validateDefinitionRegistration(definition, catalog),
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
    const catalogExecutor = catalog.executors.find((candidate) =>
      sameIdentity(candidate.executor, parsedExecutor),
    );
    if (catalogExecutor === undefined)
      throw new NodeRegistryCompatibilityError(
        `executor ${parsedExecutor.key}@${String(parsedExecutor.version)} is not in the catalog`,
      );
    if (
      catalogExecutor.abiVersion !== registration.abiVersion ||
      !sameIdentitySet(catalogExecutor.definitions, registration.definitions) ||
      !sameIdentitySet(
        catalogExecutor.policyReferences,
        registration.policyReferences,
      )
    )
      throw new NodeRegistryCompatibilityError(
        `executor ${parsedExecutor.key}@${String(parsedExecutor.version)} does not match the catalog`,
      );
    for (const definition of registration.definitions) {
      if (!definitionMap.has(identityToken(definition)))
        throw new NodeRegistryCompatibilityError(
          `executor ${parsedExecutor.key}@${String(parsedExecutor.version)} declares an unknown definition`,
        );
    }
    executorMap.set(identityToken(parsedExecutor), {
      manifest: catalogExecutor,
      registration: Object.freeze({
        abiVersion: registration.abiVersion,
        definitions: Object.freeze(
          registration.definitions.map((identity) =>
            Object.freeze({ ...identity }),
          ),
        ),
        executor: Object.freeze({ ...parsedExecutor }),
        policyReferences: Object.freeze(
          registration.policyReferences.map((identity) =>
            Object.freeze({ ...identity }),
          ),
        ),
        execute: registration.execute,
      }),
    });
  }

  for (const manifest of catalog.definitions) {
    const definition = definitionMap.get(identityToken(manifest.definition));
    if (definition === undefined)
      throw new NodeRegistryCompatibilityError(
        `catalog definition ${manifest.definition.key}@${String(manifest.definition.version)} has no server schema registration`,
      );
    const executor = executorMap.get(identityToken(manifest.executor));
    if (executor === undefined)
      throw new NodeRegistryCompatibilityError(
        `definition ${manifest.definition.key}@${String(manifest.definition.version)} has no exact executor registration`,
      );
    const executorManifest = catalog.executors.find((candidate) =>
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
    if (manifest.executorAbi !== executor.registration.abiVersion)
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
  }

  return { definitionMap, executorMap };
}

export function createNodeRegistry(options: NodeRegistryOptions): NodeRegistry {
  let catalog: NodeCatalog;
  try {
    catalog = parseNodeCatalog(options.catalog);
  } catch (error) {
    throw new NodeRegistryCompatibilityError('invalid node catalog', {
      cause: safeNodeCatalogFailureCause(error),
    });
  }
  const { definitionMap, executorMap } = pinRegistrations(catalog, options);
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
    assertDefinitionExecutorBinding(definition.manifest, request.executor);
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
    assertDefinitionExecutorBinding(definition.manifest, request.executor);
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
    dispatchMode,
    execute,
  });
}
