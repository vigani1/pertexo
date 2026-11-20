import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import {
  databaseConfigSchema,
  databaseExecutionConfigSchema,
  databaseInputSchema,
  databaseOutputSchema,
} from './execute.schemas.js';

export const DATABASE_EXECUTOR = Object.freeze({
  key: 'database.execute',
  version: 1,
});
const DATABASE_EXECUTOR_ABI = 2;

export const POSTGRES_CONNECTION_SLOT = 'postgres';

const manifest: NodeManifest = Object.freeze({
  definition: DATABASE_EXECUTOR,
  family: 'action',
  display: {
    name: 'Database',
    description: 'Run queries and write rows in PostgreSQL',
    sideEffect: 'This step can change data in the selected database.',
  },
  configVersion: 1,
  configSchema: generateSchemaDocument(databaseConfigSchema),
  inputSchema: generateSchemaDocument(databaseInputSchema),
  outputSchema: generateSchemaDocument(databaseOutputSchema),
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [POSTGRES_CONNECTION_SLOT],
  connectionRequirements: [POSTGRES_CONNECTION_SLOT],
  integration: { providerKey: 'postgres', operationKey: 'execute' },
  retryClass: 'unsafe',
  resourceClass: 'io',
  capabilities: ['side_effect_disclosure'],
  executor: DATABASE_EXECUTOR,
  executorAbi: DATABASE_EXECUTOR_ABI,
  policyReferences: [],
});

export const DATABASE_DEFINITION_REGISTRATION = Object.freeze({
  manifest,
  configSchema: databaseConfigSchema,
  executionConfigSchema: databaseExecutionConfigSchema,
  inputSchema: databaseInputSchema,
  outputSchema: databaseOutputSchema,
});
