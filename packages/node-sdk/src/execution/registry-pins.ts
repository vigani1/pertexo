import type { ZodType } from 'zod';
import { assertAttemptOnlyManifest } from '../definitions/execution-class.js';
import {
  type DefinitionIdentity,
  type ExecutorIdentity,
  executorIdentitySchema,
  type ExecutorManifest,
  type NodeManifest,
  nodeManifestSchema,
  type PolicyReference,
  type NodeCatalog,
  generateSchemaDocument,
  parseNodeCatalog,
} from '../definitions/catalog.js';
import { identityToken } from '../definitions/identity.js';
import {
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  validateInlineFallback,
} from './executor-binding.js';
import type {
  NodeDefinitionRegistration,
  NodeExecutorRegistration,
  NodeRegistryOptions,
} from './node-execution.types.js';
import { NodeRegistryCompatibilityError } from './node-execution.errors.js';
import {
  type AssistantDisclosure,
  validateAssistantDisclosure,
} from './assistant-disclosure.js';

const SUPPORTED_EXECUTOR_ABI_VERSIONS = new Set<number>([
  1,
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
]);

export interface PinnedNodeDefinition {
  readonly manifest: NodeManifest;
  readonly assistantDisclosure?: AssistantDisclosure;
  readonly configSchema: ZodType;
  readonly inputSchema: ZodType;
  readonly outputSchema: ZodType;
}

export interface PinnedNodeExecutor {
  readonly manifest: ExecutorManifest;
  readonly execute: NodeExecutorRegistration['execute'];
}

interface PinnedRegistrations {
  readonly definitionMap: ReadonlyMap<string, PinnedNodeDefinition>;
  readonly executorMap: ReadonlyMap<string, PinnedNodeExecutor>;
}

function stableComparable(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableComparable);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      })
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
  const comparable = ({ execution = 'attempt', ...fields }: NodeManifest) =>
    JSON.stringify(stableComparable({ ...fields, execution }));
  return comparable(left) === comparable(right);
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
  catalogManifest: NodeManifest,
): PinnedNodeDefinition {
  const parsed = nodeManifestSchema.parse(registration.manifest);
  if (!sameManifest(catalogManifest, parsed))
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
  validateAssistantDisclosure(registration);
  return {
    manifest: parsed,
    ...(registration.assistantDisclosure === undefined
      ? {}
      : { assistantDisclosure: registration.assistantDisclosure }),
    configSchema: registration.configSchema,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
  };
}

/**
 * Pair every catalog definition with its runtime schemas and every catalog
 * executor with its implementation. The catalog owns the executor metadata;
 * registrations outside the catalog are not served.
 */
export function pinRegistrations(
  options: NodeRegistryOptions,
): PinnedRegistrations {
  let catalog: NodeCatalog;
  try {
    catalog = parseNodeCatalog(options.catalog);
  } catch (error) {
    throw new NodeRegistryCompatibilityError('invalid node catalog', {
      cause: safeNodeCatalogFailureCause(error),
    });
  }
  for (const { manifest } of options.definitions)
    assertAttemptOnlyManifest(manifest);
  const registeredDefinitions = [
    ...(options.core?.definitions ?? []),
    ...options.definitions,
  ];
  const registeredExecutors = [
    ...(options.core?.executors ?? []),
    ...options.executors,
  ];
  validateUnique(
    'definition',
    registeredDefinitions.map(({ manifest }) => manifest.definition),
  );
  validateUnique(
    'executor',
    registeredExecutors.map(({ executor }) => executor),
  );
  const definitions = new Map(
    registeredDefinitions.map((registration) => [
      identityToken(registration.manifest.definition),
      registration,
    ]),
  );
  const executors = new Map(
    registeredExecutors.map((registration) => [
      identityToken(executorIdentitySchema.parse(registration.executor)),
      registration,
    ]),
  );
  const definitionMap = new Map<string, PinnedNodeDefinition>();
  for (const manifest of catalog.definitions) {
    const token = identityToken(manifest.definition);
    const registration = definitions.get(token);
    if (registration === undefined)
      throw new NodeRegistryCompatibilityError(
        `catalog definition ${manifest.definition.key}@${String(manifest.definition.version)} has no server schema registration`,
      );
    const pinned = validateDefinitionRegistration(registration, manifest);
    validateInlineFallback(manifest, options.core?.executors);
    definitionMap.set(token, pinned);
  }
  const executorMap = new Map<string, PinnedNodeExecutor>();
  for (const manifest of catalog.executors) {
    const label = `${manifest.executor.key}@${String(manifest.executor.version)}`;
    if (!SUPPORTED_EXECUTOR_ABI_VERSIONS.has(manifest.abiVersion))
      throw new NodeRegistryCompatibilityError(
        `executor ${label} uses unsupported ABI ${String(manifest.abiVersion)}`,
      );
    const registration = executors.get(identityToken(manifest.executor));
    if (registration === undefined)
      throw new NodeRegistryCompatibilityError(
        `catalog executor ${label} has no implementation`,
      );
    executorMap.set(identityToken(manifest.executor), {
      manifest,
      execute: registration.execute,
    });
  }
  return { definitionMap, executorMap };
}
