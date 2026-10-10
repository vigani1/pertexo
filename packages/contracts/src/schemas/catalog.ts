import { z } from 'zod';

const identityKey = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u);

export const catalogLimits = Object.freeze({
  definitions: 256,
  integrations: 128,
  requirements: 64,
  capabilities: 64,
  schemaProperties: 10_000,
});

const catalogDefinitionIdentitySchema = z
  .object({ key: identityKey, version: z.number().int().positive() })
  .strict()
  .readonly();

/** Discovery is intentionally unfiltered; reject accidental arbitrary query keys. */
export const catalogQuerySchema = z.object({}).strict();

const schemaDocumentSchema = z
  .record(z.string().max(256), z.json())
  .superRefine((document, context) => {
    if (Object.keys(document).length > catalogLimits.schemaProperties)
      context.addIssue({
        code: 'custom',
        message: 'schema document exceeds the property limit',
      });
  })
  .readonly();

const nodePortsSchema = z
  .object({
    inputs: z.array(z.string().min(1).max(128)).max(64),
    outputs: z.array(z.string().min(1).max(128)).max(64),
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
    configVersion: z.number().int().positive(),
    configSchema: schemaDocumentSchema,
    inputSchema: schemaDocumentSchema,
    outputSchema: schemaDocumentSchema,
    ports: nodePortsSchema,
    credentialRequirements: z
      .array(z.string().min(1).max(128))
      .max(catalogLimits.requirements),
    connectionRequirements: z
      .array(z.string().min(1).max(128))
      .max(catalogLimits.requirements),
    integration: nodeIntegrationSchema.optional(),
    retryClass: z.enum(['safe', 'idempotent-with-key', 'unsafe']),
    resourceClass: z.enum(['io', 'cpu']),
    capabilities: z
      .array(z.string().min(1).max(128))
      .max(catalogLimits.capabilities),
  })
  .strict()
  .readonly();

export const nodeDefinitionListResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z
      .array(nodeDefinitionCatalogItemSchema)
      .max(catalogLimits.definitions),
  })
  .strict()
  .readonly();

const integrationCatalogItemSchema = z
  .object({
    providerKey: identityKey,
    operationKey: identityKey,
    nodeDefinitions: z
      .array(catalogDefinitionIdentitySchema)
      .max(catalogLimits.definitions),
  })
  .strict()
  .readonly();

export const integrationListResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z
      .array(integrationCatalogItemSchema)
      .max(catalogLimits.integrations),
  })
  .strict()
  .readonly();

export type NodeDefinitionCatalogItem = z.output<
  typeof nodeDefinitionCatalogItemSchema
>;
export type NodeDefinitionListResponse = z.output<
  typeof nodeDefinitionListResponseSchema
>;
export type IntegrationListResponse = z.output<
  typeof integrationListResponseSchema
>;
