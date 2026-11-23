import { responseSchema } from './shared/response-schema.js';
import {
  NODE_CATALOG_COUNT_LIMITS,
  NODE_IDENTITY_KEY_MAX_CHARACTERS,
  NODE_IDENTITY_KEY_PATTERN,
  codeSettingsSchema,
  nodeDisplayMetadataSchema,
  outputVariantSelectionSchema,
} from '@pertexo/node-sdk';
import { z } from 'zod';

/** How large the step and integration catalog may grow, and how long its names are. */
export const CATALOG_LIMITS = Object.freeze({
  ...NODE_CATALOG_COUNT_LIMITS,
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
  .regex(new RegExp(NODE_IDENTITY_KEY_PATTERN, 'u'));

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
    presentation: z
      .object({
        name: z.string().min(1).max(CATALOG_LIMITS.nameCharacters),
        icon: identityKey,
        group: z.enum(['trigger', 'action']),
        community: z
          .strictObject({
            publisher: z
              .string()
              .min(1)
              .max(CATALOG_LIMITS.identityKeyCharacters),
            origin: z.url(),
            version: z.string().optional(),
            retained: z.literal(true).optional(),
          })
          .readonly()
          .optional(),
      })
      .strict()
      .readonly()
      .optional(),
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

const oauth2PresetSchema = z
  .strictObject({
    key: identityKey,
    label: z.string(),
    values: z
      .strictObject({
        grantType: z.literal('authorization_code'),
        authorizationUrl: z.url(),
        tokenUrl: z.url(),
        scope: z.string(),
        clientAuthentication: z.enum(['basic', 'body']),
        pkce: z.enum(['s256', 'none']),
        authorizationParameters: z.string(),
        tokenParameters: z.string(),
        hostMode: z.enum(['any', 'listed']),
        hosts: z.string(),
      })
      .readonly(),
  })
  .readonly();

const connectionFormDefinitionSchema = z
  .strictObject({
    providerKey: identityKey,
    authType: identityKey,
    icon: identityKey,
    presets: z
      .array(oauth2PresetSchema)
      .max(CATALOG_LIMITS.integrations)
      .readonly()
      .optional(),
    presentation: z
      .strictObject({
        choice: identityKey,
        pickerOrder: z.number().int().nonnegative().optional(),
        name: z.string(),
        purpose: z.string(),
        credential: z.string(),
        savedCredential: z.string(),
        usedBy: z.string(),
        nameSuffix: z.string(),
        variant: z.string().optional(),
        variantPrompt: z.string().optional(),
        requirement: z.string().optional(),
        testCopy: z
          .strictObject({
            name: z.string().optional(),
            introNote: z.string().optional(),
            credential: z.string().optional(),
            rejectionReason: z.string().optional(),
            rejectionHelp: z.string().optional(),
            consentDetail: z.string().optional(),
            failureReasons: z.record(z.string(), z.string()).optional(),
          })
          .readonly()
          .optional(),
        maskedSummary: z
          .strictObject({
            field: z.string(),
            label: z.string(),
            prefix: z.string(),
            senderField: z.string().optional(),
          })
          .readonly()
          .optional(),
      })
      .readonly(),
    fields: schemaDocumentSchema,
    slot: identityKey,
    test: z.enum(['http', 'oauth2', 'postgres', 'smtp', 'signing', 'lookup']),
    testInput: z.enum(['url', 'provider', 'consent']),
    testAutomatically: z.literal(true).optional(),
  })
  .readonly();

export type ConnectionFormDefinition = z.output<
  typeof connectionFormDefinitionSchema
>;

export const nodeDefinitionListResponseSchema = responseSchema(
  z
    .object({
      codeSettings: codeSettingsSchema.optional(),
      connections: z
        .array(connectionFormDefinitionSchema)
        .max(CATALOG_LIMITS.integrations)
        .optional(),
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
