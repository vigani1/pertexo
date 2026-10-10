import { z } from 'zod';

import { cloneAndFreeze } from './freeze.js';
import { compareIdentity, identityToken } from './identity.js';
import {
  schemaDocumentSchema,
  type SchemaDocument,
} from './definitions/schema-document.js';

export {
  BOUNDED_NODE_JSON_RECORD_SCHEMA_DOCUMENT,
  BOUNDED_NODE_JSON_SCHEMA_DOCUMENT,
  NODE_JSON_LIMITS,
  boundedNodeJsonRecordSchema,
  boundedNodeJsonSchema,
  generateSchemaDocument,
  isBoundedNodeJson,
} from './definitions/schema-document.js';
export type {
  SchemaDocument,
  SchemaJson,
  SchemaObject,
  SchemaProjectionOptions,
} from './definitions/schema-document.js';

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

export type RetryClass = 'safe' | 'idempotent-with-key' | 'unsafe';
export type ResourceClass = 'io' | 'cpu';

export interface NodePorts {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

/** Stable provider operation identity used by derived workflow impact indexes. */
export interface NodeIntegrationOperation {
  readonly providerKey: string;
  readonly operationKey: string;
}

/** One node definition: its contract, ports, requirements and pinned executor. */
export interface NodeManifest {
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
  readonly executor: ExecutorIdentity;
  readonly executorAbi: number;
  readonly policyReferences: readonly PolicyReference[];
}

export interface ExecutorManifest {
  readonly executor: ExecutorIdentity;
  readonly abiVersion: number;
  readonly definitions: readonly DefinitionIdentity[];
  readonly policyReferences: readonly PolicyReference[];
}

/** The nodes a deployment serves: definitions, their executors and the policies both reference. */
export interface NodeCatalog {
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
export const policyReferenceSchema = identitySchema;

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

export const nodeManifestSchema = z
  .object({
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
    executor: executorIdentitySchema,
    executorAbi: z.number().int().positive(),
    policyReferences: z.array(policyReferenceSchema),
  })
  .strict();

export const executorManifestSchema = z
  .object({
    executor: executorIdentitySchema,
    abiVersion: z.number().int().positive(),
    definitions: z.array(definitionIdentitySchema),
    policyReferences: z.array(policyReferenceSchema),
  })
  .strict();

export const nodeCatalogSchema = z
  .object({
    definitions: z.array(nodeManifestSchema),
    executors: z.array(executorManifestSchema),
    policies: z.array(policyReferenceSchema),
  })
  .strict();

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

function validateCatalogEdges(input: NodeCatalog): void {
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
    rejectDuplicateIdentities('definition policy', manifest.policyReferences);
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
    if (manifest.executorAbi !== executor.abiVersion)
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

/** The executor manifest of a node whose executor serves only that definition. */
export function executorManifestFor(manifest: NodeManifest): ExecutorManifest {
  return {
    executor: manifest.executor,
    abiVersion: manifest.executorAbi,
    definitions: [manifest.definition],
    policyReferences: manifest.policyReferences,
  };
}

function normalizeCatalog(input: unknown): NodeCatalog {
  const parsed = nodeCatalogSchema.parse(input);
  validateCatalogEdges(parsed);
  return cloneAndFreeze({
    definitions: [...parsed.definitions].sort((left, right) =>
      compareIdentity(left.definition, right.definition),
    ),
    executors: [...parsed.executors].sort((left, right) =>
      compareIdentity(left.executor, right.executor),
    ),
    policies: [...parsed.policies].sort(compareIdentity),
  });
}

/** Validate a catalog's identities and edges, then return it sorted and frozen. */
export function createNodeCatalog(input: NodeCatalog): NodeCatalog {
  return normalizeCatalog(input);
}

/** Parse an untrusted catalog with the same checks. */
export function parseNodeCatalog(input: unknown): NodeCatalog {
  return normalizeCatalog(input);
}
