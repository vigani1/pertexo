import { createRecipeExecutor } from './recipe.executor.js';
import { recipeConnection } from './recipe-connection.js';
import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from '@pertexo/node-sdk/server';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';
import type { IntegrationModule } from '../providers/integration-module.js';
import { communityContractDigest } from './contract-digest.js';
import {
  COMMUNITY_FORMAT_VERSION,
  communityProviderKey,
  communityCredentialFieldSchema,
  type CommunityAction,
  type CommunityConnection,
  type CommunityManifest,
  type CommunitySchemaField,
} from './manifest.schemas.js';
import { COMMUNITY_MANIFEST_LIMITS as limits } from './manifest-limits.js';

const COMMUNITY_DEFINITION_VERSION = 1;
const CONFIG_SCHEMA = z.strictObject({});

export function compileCommunityManifest(
  manifest: CommunityManifest,
): IntegrationModule {
  const providerKey = communityProviderKey(manifest);
  const { origin, presentation } = manifest;
  const credential =
    manifest.connection === undefined
      ? undefined
      : compileConnection(
          manifest.connection,
          providerKey,
          origin,
          presentation,
        );
  return {
    key: providerKey,
    presentation: {
      name: presentation.name,
      icon: presentation.icon,
      group: 'action',
      community: { publisher: manifest.publisher, origin },
    },
    ...(credential === undefined
      ? {}
      : { connections: [credential.definition] }),
    steps: manifest.actions.map((action) =>
      compileOperation(
        providerKey,
        origin,
        action,
        action.connection === undefined ? undefined : credential,
      ),
    ),
  };
}

function compileConnection(
  connection: CommunityConnection,
  providerKey: string,
  origin: string,
  { name, description }: CommunityManifest['presentation'],
) {
  const { fields, auth, test } = connection;
  const credentialFields = Object.entries(fields).map(
    ([key, { label, kind, default: initial }]) => {
      const field = communityCredentialFieldSchema(auth, key);
      return [
        key,
        (initial === undefined ? field : field.default(initial)).meta({
          title: label,
          secret: kind === 'secret',
        }),
      ] as const;
    },
  );
  const contract = {
    providerKey,
    origin,
    auth,
    test,
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, { kind, default: initial }]) => [
        key,
        initial === undefined ? { kind } : { kind, default: initial },
      ]),
    ),
  };
  const digest = communityContractDigest('credential', contract);
  const authType = `community_${digest}`;
  const fieldShape = Object.fromEntries(credentialFields);
  const definition = {
    authType,
    presentation: {
      choice: providerKey,
      name,
      purpose: description,
      credential: name,
      savedCredential: name,
      usedBy: name,
      nameSuffix: name,
    },
    fields: z.strictObject(fieldShape),
    schema: z.strictObject({ ...fieldShape, type: z.literal(authType) }),
    auth,
    test: {
      kind: 'http',
      approvedOrigin: origin,
      method: test.method,
      target: new URL(test.path, origin).href,
      success: { status: '2xx' },
    },
    slot: { key: `community.${digest}`, primary: true },
  } satisfies ConnectionDefinition;
  return {
    definition,
    binding: recipeConnection(providerKey, definition, auth),
  };
}

function compileOperation(
  providerKey: string,
  origin: string,
  action: CommunityAction,
  credential: ReturnType<typeof compileConnection> | undefined,
): IntegrationModule['steps'][number] {
  const { name, description, connection: _connection, ...operation } = action;
  const contract = {
    format: COMMUNITY_FORMAT_VERSION,
    providerKey,
    origin,
    ...operation,
    credential: credential?.definition.authType ?? null,
  };
  const definition = {
    key: `community.${communityContractDigest('definition', contract)}`,
    version: COMMUNITY_DEFINITION_VERSION,
  };
  const executor = {
    key: `community.${communityContractDigest('executor', contract)}`,
    version: COMMUNITY_DEFINITION_VERSION,
  };
  const inputSchema = compileFields(action.input);
  const outputSchema = compileFields(action.output);
  const slots =
    credential === undefined ? [] : [credential.definition.slot.key];
  const manifest: NodeManifest = {
    definition,
    family: 'action',
    display: { name, description },
    configVersion: COMMUNITY_DEFINITION_VERSION,
    configSchema: generateSchemaDocument(CONFIG_SCHEMA),
    inputSchema: generateSchemaDocument(inputSchema),
    outputSchema: generateSchemaDocument(outputSchema),
    ports: { inputs: ['in'], outputs: ['out'] },
    credentialRequirements: slots,
    connectionRequirements: slots,
    integration: { providerKey, operationKey: action.key },
    retryClass: action.sideEffect,
    resourceClass: 'io',
    capabilities: ['external_http'],
    executor,
    executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
    policyReferences: [],
  };
  return {
    registration: {
      manifest,
      configSchema: CONFIG_SCHEMA,
      inputSchema,
      outputSchema,
    },
    createExecutor: (dependencies) =>
      createRecipeExecutor(dependencies, executor, {
        origin,
        action,
        binding: credential?.binding,
      }),
  };
}

const FIELD_SCHEMAS = {
  string: z.string().max(limits.stringCharacters),
  number: z.number(),
  integer: z.number().int(),
  boolean: z.boolean(),
};

function compileFields(
  descriptors: Readonly<Record<string, CommunitySchemaField>>,
) {
  return z.strictObject(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, field]) => {
        const schema = FIELD_SCHEMAS[field.type];
        return [key, field.required ? schema : schema.optional()];
      }),
    ),
  );
}
