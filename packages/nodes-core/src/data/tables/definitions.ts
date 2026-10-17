import { z } from 'zod';
import {
  generateSchemaDocument,
  dataTableNameSchema,
  dataTableQuerySchema,
  dataTableValuesSchema,
  dataTableResultSchema,
  type NodeManifest,
} from '@pertexo/node-sdk';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import { CORE_BOUNDED_JSON_POLICY } from '../../policies.js';
export const DATA_TABLE_OPERATIONS = [
  'find',
  'insert',
  'update',
  'upsert',
  'delete',
] as const;
const DATA_TABLE_CONFIG_SCHEMA = z
  .object({ table: dataTableNameSchema })
  .strict();
const query = dataTableQuerySchema.default({
  filters: [],
  limit: 100,
  offset: 0,
});
const DATA_TABLE_INPUT_SCHEMAS = {
  find: z.object({ query }).strict(),
  insert: z.object({ values: dataTableValuesSchema }).strict(),
  update: z.object({ query, values: dataTableValuesSchema }).strict(),
  upsert: z.object({ values: dataTableValuesSchema }).strict(),
  delete: z.object({ query }).strict(),
};
export const DATA_TABLE_DEFINITIONS: readonly NodeDefinitionRegistration[] =
  DATA_TABLE_OPERATIONS.map((operation) => {
    const definition = Object.freeze({
      key: `core.table_${operation}`,
      version: 1,
    });
    const inputSchema = DATA_TABLE_INPUT_SCHEMAS[operation];
    const manifest: NodeManifest = Object.freeze({
      definition,
      family: operation === 'find' ? 'transform' : 'action',
      configVersion: 1,
      configSchema: generateSchemaDocument(DATA_TABLE_CONFIG_SCHEMA),
      inputSchema: generateSchemaDocument(inputSchema),
      outputSchema: generateSchemaDocument(dataTableResultSchema),
      ports: Object.freeze({
        inputs: Object.freeze(['in']),
        outputs: Object.freeze(['out']),
      }),
      credentialRequirements: Object.freeze([]),
      connectionRequirements: Object.freeze([]),
      retryClass: operation === 'find' ? 'safe' : 'idempotent-with-key',
      resourceClass: 'io',
      capabilities: Object.freeze([]),
      executor: definition,
      executorAbi: operation === 'find' ? 1 : 2,
      policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
    });
    return {
      manifest,
      configSchema: DATA_TABLE_CONFIG_SCHEMA,
      inputSchema,
      outputSchema: dataTableResultSchema,
    };
  });
