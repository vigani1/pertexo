import {
  generateSchemaDocument,
  STORED_EXECUTION_VALUE_LIMITS,
} from '@pertexo/node-sdk';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import type { ZodType } from 'zod';
import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_JSONATA_POLICY,
} from '../../policies.js';

export function defineUtility({
  key,
  configSchema,
  inputSchema,
  outputSchema,
  semantics,
  connectionSlot,
}: Readonly<{
  key: string;
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
      configVersion: 1,
      configSchema: generateSchemaDocument(configSchema, {
        runtimeOnlySemantics: [
          ...semantics,
          `Retained output is limited to ${String(STORED_EXECUTION_VALUE_LIMITS.inlineBytes / 1024)} KiB, depth 64 and 10000 members, with valid Unicode and no NUL.`,
        ],
      }),
      inputSchema: generateSchemaDocument(inputSchema),
      outputSchema: generateSchemaDocument(outputSchema, {
        runtimeOnlySemantics: [
          ...semantics,
          `Retained output is limited to ${String(STORED_EXECUTION_VALUE_LIMITS.inlineBytes / 1024)} KiB, depth 64 and 10000 members, with valid Unicode and no NUL.`,
        ],
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
