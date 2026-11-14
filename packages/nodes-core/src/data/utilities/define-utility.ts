import {
  formatByteSize,
  formatCount,
  generateSchemaDocument,
  type NodeDisplayMetadata,
  STORED_EXECUTION_VALUE_LIMITS,
} from '@pertexo/node-sdk';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import type { ZodType } from 'zod';
import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_JSONATA_POLICY,
} from '../../catalog/core-policies.js';

const RETAINED_OUTPUT_SEMANTIC = `Retained output is limited to ${formatByteSize(STORED_EXECUTION_VALUE_LIMITS.inlineBytes)}, depth ${String(STORED_EXECUTION_VALUE_LIMITS.depth)} and ${formatCount(STORED_EXECUTION_VALUE_LIMITS.members)} members, with valid Unicode and no NUL.`;

export function defineUtility({
  key,
  display,
  configSchema,
  inputSchema,
  outputSchema,
  semantics,
  connectionSlot,
}: Readonly<{
  key: string;
  display: NodeDisplayMetadata;
  configSchema: ZodType;
  inputSchema: ZodType;
  outputSchema: ZodType;
  semantics: readonly [string, ...string[]];
  connectionSlot?: string;
}>): NodeDefinitionRegistration {
  const identity = Object.freeze({ key, version: 1 });
  return Object.freeze({
    configSchema,
    inputSchema,
    outputSchema,
    manifest: Object.freeze({
      definition: identity,
      executor: identity,
      family: 'transform',
      display: Object.freeze({ ...display }),
      configVersion: 1,
      configSchema: generateSchemaDocument(configSchema, {
        runtimeOnlySemantics: [...semantics, RETAINED_OUTPUT_SEMANTIC],
      }),
      inputSchema: generateSchemaDocument(inputSchema),
      outputSchema: generateSchemaDocument(outputSchema, {
        runtimeOnlySemantics: [...semantics, RETAINED_OUTPUT_SEMANTIC],
      }),
      ports: Object.freeze({
        inputs: Object.freeze(['in']),
        outputs: Object.freeze(['out']),
      }),
      credentialRequirements: Object.freeze([]),
      connectionRequirements: Object.freeze(
        connectionSlot === undefined ? [] : [connectionSlot],
      ),
      retryClass: 'safe',
      resourceClass: connectionSlot === undefined ? 'cpu' : 'io',
      capabilities: Object.freeze([]),
      executorAbi: 1,
      policyReferences: Object.freeze([
        CORE_BOUNDED_JSON_POLICY,
        CORE_JSONATA_POLICY,
      ]),
    }),
  });
}
