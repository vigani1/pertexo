import { z } from 'zod';

const identityKey = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u);

export const catalogLimitsV1 = Object.freeze({
  definitions: 256,
  integrations: 128,
  requirements: 64,
  capabilities: 64,
  schemaProperties: 10_000,
});

export const catalogDefinitionIdentitySchema = z
  .object({ key: identityKey, version: z.number().int().positive() })
  .strict()
  .readonly();

/** Discovery is intentionally unfiltered; reject accidental arbitrary query keys. */
export const catalogQuerySchema = z.object({}).strict();

export const catalogReleaseSchema = z
  .object({
    epoch: z.number().int().positive(),
    fingerprint: z.string().regex(/^node-compat:v1:sha256:[a-f0-9]{64}$/u),
  })
  .strict()
  .readonly();

const schemaDocumentSchema = z
  .record(z.string().max(256), z.json())
  .superRefine((document, context) => {
    if (Object.keys(document).length > catalogLimitsV1.schemaProperties)
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
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    definition: catalogDefinitionIdentitySchema,
    family: z.enum(['trigger', 'action', 'logic', 'transform', 'output']),
    configVersion: z.number().int().positive(),
    configSchema: schemaDocumentSchema,
    inputSchema: schemaDocumentSchema,
    outputSchema: schemaDocumentSchema,
    ports: nodePortsSchema,
    credentialRequirements: z
      .array(z.string().min(1).max(128))
      .max(catalogLimitsV1.requirements),
    connectionRequirements: z
      .array(z.string().min(1).max(128))
      .max(catalogLimitsV1.requirements),
    integration: nodeIntegrationSchema.optional(),
    retryClass: z.enum(['safe', 'idempotent-with-key', 'unsafe']),
    resourceClass: z.enum(['io', 'cpu']),
    capabilities: z
      .array(z.string().min(1).max(128))
      .max(catalogLimitsV1.capabilities),
    lifecycle: z.enum([
      'active',
      'deprecated',
      'migration_required',
      'retired',
    ]),
    available: z
      .boolean()
      .describe('Definition is available for new workflow placement.'),
    publishable: z
      .boolean()
      .describe(
        'Definition may be selected for publication after full workflow validation.',
      ),
  })
  .strict()
  .readonly();

export const nodeDefinitionListResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    release: catalogReleaseSchema,
    items: z
      .array(nodeDefinitionCatalogItemSchema)
      .max(catalogLimitsV1.definitions),
  })
  .strict()
  .readonly();

export const integrationCatalogItemSchema = z
  .object({
    providerKey: identityKey,
    operationKey: identityKey,
    nodeDefinitions: z
      .array(catalogDefinitionIdentitySchema)
      .max(catalogLimitsV1.definitions),
    available: z
      .boolean()
      .describe(
        'At least one operation definition is available for placement.',
      ),
    publishable: z
      .boolean()
      .describe(
        'At least one operation definition may be published after full validation.',
      ),
  })
  .strict()
  .readonly();

export const integrationListResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    release: catalogReleaseSchema,
    items: z
      .array(integrationCatalogItemSchema)
      .max(catalogLimitsV1.integrations),
  })
  .strict()
  .readonly();

export type CatalogRelease = z.output<typeof catalogReleaseSchema>;
export type NodeDefinitionCatalogItem = z.output<
  typeof nodeDefinitionCatalogItemSchema
>;
export type NodeDefinitionListResponse = z.output<
  typeof nodeDefinitionListResponseSchema
>;
export type IntegrationCatalogItem = z.output<
  typeof integrationCatalogItemSchema
>;
export type IntegrationListResponse = z.output<
  typeof integrationListResponseSchema
>;
