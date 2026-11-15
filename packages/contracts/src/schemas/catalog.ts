import { responseSchema } from './shared/response-schema.js';
import {
  NODE_IDENTITY_KEY_MAX_CHARACTERS,
  codeSettingsSchema,
  nodeDisplayMetadataSchema,
  outputVariantSelectionSchema,
} from '@pertexo/node-sdk';
import { z } from 'zod';

/** How large the step and integration catalog may grow, and how long its names are. */
export const CATALOG_LIMITS = Object.freeze({
  definitions: 256,
  integrations: 128,
  requirements: 64,
  capabilities: 64,
  ports: 64,
  schemaProperties: 10_000,
  identityKeyCharacters: NODE_IDENTITY_KEY_MAX_CHARACTERS,
  schemaKeyCharacters: 256,
  // A port, requirement or capability name.
  nameCharacters: 128,
});

const identityKey = z
  .string()
  .min(1)
  .max(CATALOG_LIMITS.identityKeyCharacters)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u);

const catalogDefinitionIdentitySchema = z
  .object({ key: identityKey, version: z.number().int().positive() })
  .strict()
  .readonly();

/** Discovery is intentionally unfiltered; reject accidental arbitrary query keys. */
export const catalogQuerySchema = z.object({}).strict();

const schemaDocumentSchema = z
  .record(z.string().max(CATALOG_LIMITS.schemaKeyCharacters), z.json())
  .superRefine((document, context) => {
    if (Object.keys(document).length > CATALOG_LIMITS.schemaProperties)
      context.addIssue({
        code: 'custom',
        message: 'schema document exceeds the property limit',
      });
  })
  .readonly();

const nodePortsSchema = z
  .object({
    inputs: z
      .array(z.string().min(1).max(CATALOG_LIMITS.nameCharacters))
      .max(CATALOG_LIMITS.ports),
    outputs: z
      .array(z.string().min(1).max(CATALOG_LIMITS.nameCharacters))
      .max(CATALOG_LIMITS.ports),
  })
  .strict()
  .readonly();

const nodeIntegrationSchema = z
  .object({
    providerKey: identityKey,
    operationKey: identityKey,
  })
  .strict()
  .readonly();

export const nodeDefinitionCatalogItemSchema = z
  .object({
    definition: catalogDefinitionIdentitySchema,
    family: z.enum(['trigger', 'action', 'logic', 'transform', 'output']),
    display: nodeDisplayMetadataSchema.optional(),
    configVersion: z.number().int().positive(),
    configSchema: schemaDocumentSchema,
    inputSchema: schemaDocumentSchema,
    outputSchema: schemaDocumentSchema,
    outputVariant: outputVariantSelectionSchema.optional(),
    ports: nodePortsSchema,
    credentialRequirements: z
      .array(z.string().min(1).max(CATALOG_LIMITS.nameCharacters))
      .max(CATALOG_LIMITS.requirements),
    connectionRequirements: z
      .array(z.string().min(1).max(CATALOG_LIMITS.nameCharacters))
      .max(CATALOG_LIMITS.requirements),
    optionalConnections: z
      .array(z.string().min(1).max(CATALOG_LIMITS.nameCharacters))
      .max(CATALOG_LIMITS.requirements)
      .optional(),
    integration: nodeIntegrationSchema.optional(),
    retryClass: z.enum(['safe', 'idempotent-with-key', 'unsafe']),
    resourceClass: z.enum(['io', 'cpu']),
    capabilities: z
      .array(z.string().min(1).max(CATALOG_LIMITS.nameCharacters))
      .max(CATALOG_LIMITS.capabilities),
  })
  .strict()
  .readonly();

export const nodeDefinitionListResponseSchema = responseSchema(
  z
    .object({
      codeSettings: codeSettingsSchema.optional(),
      items: z
        .array(nodeDefinitionCatalogItemSchema)
        .max(CATALOG_LIMITS.definitions),
    })
    .strict()
    .readonly(),
);

const integrationCatalogItemSchema = z
  .object({
    providerKey: identityKey,
    operationKey: identityKey,
    nodeDefinitions: z
      .array(catalogDefinitionIdentitySchema)
      .max(CATALOG_LIMITS.definitions),
  })
  .strict()
  .readonly();

export const integrationListResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(integrationCatalogItemSchema)
        .max(CATALOG_LIMITS.integrations),
    })
    .strict()
    .readonly(),
);

export type NodeDefinitionCatalogItem = z.output<
  typeof nodeDefinitionCatalogItemSchema
>;
export type NodeDefinitionListResponse = z.output<
  typeof nodeDefinitionListResponseSchema
>;
export type IntegrationListResponse = z.output<
  typeof integrationListResponseSchema
>;
