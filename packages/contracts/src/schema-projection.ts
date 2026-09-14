import {
  workflowGraphSchema,
  workflowGraphStructuralSchemaV1,
} from '@pertexo/workflow-model/graph-contract';
import { z } from 'zod';

import {
  boundedNodeTestJsonInputSchema,
  NODE_TEST_JSON_MAX_DEPTH,
} from './http/bounded-json-input.js';

type JsonSchema = Record<string, unknown>;

const structuralWorkflowGraph = z.toJSONSchema(
  workflowGraphStructuralSchemaV1,
  { target: 'draft-2020-12', reused: 'inline' },
);

const recursiveJsonValue = z.toJSONSchema(z.json(), {
  target: 'draft-2020-12',
  reused: 'inline',
}) as JsonSchema;
Reflect.deleteProperty(recursiveJsonValue, '$schema');

function rewriteSelfReferences(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) rewriteSelfReferences(item);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.$ref === '#') record.$ref = '#/$defs/jsonValue';
  for (const nested of Object.values(record)) rewriteSelfReferences(nested);
}
rewriteSelfReferences(recursiveJsonValue);

const boundedJsonInputProjection = Object.freeze({
  $ref: '#/$defs/jsonValue',
  $defs: Object.freeze({ jsonValue: recursiveJsonValue }),
  description: `JSON input. Runtime validation rejects values deeper than ${String(NODE_TEST_JSON_MAX_DEPTH)} containers before recursive schema parsing.`,
  'x-pertexo-runtime-max-depth': NODE_TEST_JSON_MAX_DEPTH,
});

function replaceObject(target: JsonSchema, source: JsonSchema): void {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
  for (const [key, value] of Object.entries(source)) {
    if (key !== '$schema') target[key] = cloneJson(value);
  }
}

function replaceWorkflowGraph(target: JsonSchema): void {
  replaceObject(target, structuralWorkflowGraph);
  target.description =
    'Structural workflow graph contract. Runtime validation additionally enforces aggregate node/edge, nesting-depth, and encoded-byte limits.';
  target['x-pertexo-runtime-bounds'] = true;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    );
  return value;
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function rewriteLocalReferences(
  value: unknown,
  rootPrefix: string,
  path: readonly string[] = [],
  inheritedDefinitionOwner = rootPrefix,
): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      rewriteLocalReferences(
        value[index],
        rootPrefix,
        [...path, String(index)],
        inheritedDefinitionOwner,
      );
    return;
  }
  const record = value as Record<string, unknown>;
  const definitionOwner = Object.hasOwn(record, '$defs')
    ? `${rootPrefix}${path.map((part) => `/${pointerSegment(part)}`).join('')}`
    : inheritedDefinitionOwner;
  if (record.$ref === '#') record.$ref = rootPrefix;
  else if (
    typeof record.$ref === 'string' &&
    record.$ref.startsWith('#/$defs/')
  )
    record.$ref = `${definitionOwner}${record.$ref.slice('#'.length)}`;
  for (const [key, nested] of Object.entries(record))
    rewriteLocalReferences(nested, rootPrefix, [...path, key], definitionOwner);
}

export function projectContractSchema(
  name: string,
  schema: z.ZodType,
  io: 'input' | 'output',
  target: 'client' | 'openapi',
): JsonSchema {
  const projected = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    reused: 'inline',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema === (workflowGraphSchema as unknown as typeof zodSchema))
        replaceWorkflowGraph(jsonSchema);
      if (
        zodSchema ===
        (boundedNodeTestJsonInputSchema as unknown as typeof zodSchema)
      )
        replaceObject(jsonSchema, boundedJsonInputProjection);
    },
  }) as JsonSchema;
  rewriteLocalReferences(
    projected,
    target === 'openapi'
      ? `#/components/schemas/${pointerSegment(name)}`
      : `#/schemas/${pointerSegment(name)}`,
  );
  return projected;
}
