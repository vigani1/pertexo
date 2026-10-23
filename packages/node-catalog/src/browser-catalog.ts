import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import {
  approvalOutputSchema,
  formSubmissionSchema,
} from '@pertexo/workflow-model';
const inputBrowserOutputSchema = generateSchemaDocument(formSubmissionSchema);
const approvalBrowserOutputSchema =
  generateSchemaDocument(approvalOutputSchema);

import { PLATFORM_NODE_CATALOG } from './catalog.js';

/**
 * The metadata exposed to browser clients.  Runtime schemas are retained as
 * JSON documents, while executor identities, ABI details, and policy
 * references remain private runtime implementation details.
 */
export type PlatformNodeDefinitionBrowserProjection = Readonly<{
  readonly definition: Readonly<{ key: string; version: number }>;
  readonly family: NodeManifest['family'];
  readonly configVersion: number;
  readonly configSchema: NodeManifest['configSchema'];
  readonly inputSchema: NodeManifest['inputSchema'];
  readonly outputSchema: NodeManifest['outputSchema'];
  readonly outputVariant?: NodeManifest['outputVariant'];
  readonly ports: Readonly<{
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
  }>;
  readonly credentialRequirements: readonly string[];
  readonly connectionRequirements: readonly string[];
  readonly optionalConnections?: readonly string[];
  readonly integration?: Readonly<{
    readonly providerKey: string;
    readonly operationKey: string;
  }>;
  readonly retryClass: NodeManifest['retryClass'];
  readonly resourceClass: NodeManifest['resourceClass'];
  readonly capabilities: readonly string[];
}>;

export type PlatformNodeDefinitionBrowserCatalog = Readonly<{
  readonly definitions: readonly PlatformNodeDefinitionBrowserProjection[];
}>;

function compareDefinitionIdentity(
  left: Readonly<{ key: string; version: number }>,
  right: Readonly<{ key: string; version: number }>,
): number {
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return left.version - right.version;
}

/** Every definition in the served catalog, without executor or policy details. */
export function platformBrowserNodeDefinitionCatalog(): PlatformNodeDefinitionBrowserCatalog {
  const definitions = [...PLATFORM_NODE_CATALOG.definitions]
    .sort((left, right) =>
      compareDefinitionIdentity(left.definition, right.definition),
    )
    .map((projection) =>
      Object.freeze({
        definition: Object.freeze({ ...projection.definition }),
        family: projection.family,
        configVersion: projection.configVersion,
        configSchema: projection.configSchema,
        inputSchema: projection.inputSchema,
        // The executor declares a wait; mappings see only the final human result.
        outputSchema: browserOutputSchema(projection),
        ...(projection.outputVariant === undefined
          ? {}
          : { outputVariant: projection.outputVariant }),
        ports: Object.freeze({
          inputs: Object.freeze([...projection.ports.inputs]),
          outputs: Object.freeze([...projection.ports.outputs]),
        }),
        credentialRequirements: Object.freeze([
          ...projection.credentialRequirements,
        ]),
        connectionRequirements: Object.freeze([
          ...projection.connectionRequirements,
        ]),
        ...(projection.optionalConnections === undefined
          ? {}
          : {
              optionalConnections: Object.freeze([
                ...projection.optionalConnections,
              ]),
            }),
        ...(projection.integration === undefined
          ? {}
          : { integration: Object.freeze({ ...projection.integration }) }),
        retryClass: projection.retryClass,
        resourceClass: projection.resourceClass,
        capabilities: Object.freeze([...projection.capabilities]),
      }),
    );
  return Object.freeze({
    definitions: Object.freeze(definitions),
  });
}

function browserOutputSchema(
  projection: Pick<NodeManifest, 'definition' | 'outputSchema'>,
): NodeManifest['outputSchema'] {
  if (
    projection.definition.key === 'core.approval' &&
    projection.definition.version === 1
  )
    return approvalBrowserOutputSchema;
  if (
    projection.definition.key === 'core.request_input' &&
    projection.definition.version === 1
  )
    return inputBrowserOutputSchema;
  return projection.outputSchema;
}
