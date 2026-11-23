import { z } from 'zod';
import {
  generateSchemaDocument,
  dataTableConfigSchema,
  dataTableFindConfigSchema,
  DATA_TABLE_OPERATIONS,
  FIND_ROWS_V2,
  dataTableQuerySchema,
  dataTableValuesSchema,
  dataTableResultSchema,
  type NodeManifest,
} from '@pertexo/node-sdk';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import { CORE_BOUNDED_JSON_POLICY } from '../../catalog/core-policies.js';
const tableDisplay = {
  find: {
    name: 'Find rows',
    description: 'Find rows in a workspace data table',
  },
  insert: {
    name: 'Insert row',
    description: 'Insert row in a workspace data table',
    sideEffect: 'This changes real rows in a workspace data table.',
  },
  update: {
    name: 'Update rows',
    description: 'Update rows in a workspace data table',
    sideEffect: 'This changes real rows in a workspace data table.',
  },
  upsert: {
    name: 'Upsert by key',
    description: 'Upsert by key in a workspace data table',
    sideEffect: 'This changes real rows in a workspace data table.',
  },
  delete: {
    name: 'Delete rows',
    description: 'Delete rows in a workspace data table',
    sideEffect: 'This changes real rows in a workspace data table.',
  },
};
const FIND_ROWS_AGENT_TOOL = Object.freeze({
  effect: 'read',
  inputFields: Object.freeze(['query']),
  result: Object.freeze({ kind: 'bounded_output' }),
} as const);
const INSERT_ROW_AGENT_TOOL = Object.freeze({
  effect: 'write',
  inputFields: Object.freeze(['values']),
  result: Object.freeze({ kind: 'bounded_output' }),
} as const);
// prefault parses its value, so the query schema's own defaults apply.
const query = dataTableQuerySchema.prefault({});
const DATA_TABLE_INPUT_SCHEMAS = {
  find: z.object({ query }).strict(),
  insert: z.object({ values: dataTableValuesSchema }).strict(),
  update: z.object({ query, values: dataTableValuesSchema }).strict(),
  upsert: z.object({ values: dataTableValuesSchema }).strict(),
  delete: z.object({ query }).strict(),
};
export const DATA_TABLE_DEFINITIONS: readonly NodeDefinitionRegistration[] = [
  ...DATA_TABLE_OPERATIONS.map((operation) => registerTable(operation, 1)),
  registerTable('find', FIND_ROWS_V2.version),
];

function registerTable(
  operation: (typeof DATA_TABLE_OPERATIONS)[number],
  version: number,
): NodeDefinitionRegistration {
  const definition = Object.freeze({ key: `core.table_${operation}`, version });
  const inputSchema = DATA_TABLE_INPUT_SCHEMAS[operation];
  const configSchema =
    version === FIND_ROWS_V2.version
      ? dataTableFindConfigSchema
      : dataTableConfigSchema;
  const manifest: NodeManifest = Object.freeze({
    definition,
    family: operation === 'find' ? 'transform' : 'action',
    display: Object.freeze(tableDisplay[operation]),
    configVersion: 1,
    configSchema: generateSchemaDocument(configSchema),
    inputSchema: generateSchemaDocument(inputSchema),
    outputSchema: generateSchemaDocument(dataTableResultSchema),
    ports: Object.freeze({
      inputs: Object.freeze(['in']),
      outputs: Object.freeze(['out']),
    }),
    credentialRequirements: Object.freeze([]),
    connectionRequirements: Object.freeze([]),
    retryClass: operation === 'find' ? 'safe' : 'idempotent-with-key',
    ...(operation === 'find' ? { agentTool: FIND_ROWS_AGENT_TOOL } : {}),
    ...(operation === 'insert' ? { agentTool: INSERT_ROW_AGENT_TOOL } : {}),
    resourceClass: 'io',
    capabilities: Object.freeze([]),
    executor: definition,
    executorAbi: operation === 'find' ? 1 : 2,
    policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
  });
  return {
    manifest,
    configSchema,
    inputSchema,
    outputSchema: dataTableResultSchema,
  };
}
