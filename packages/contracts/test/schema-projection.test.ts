import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { nodeTestingClientContract } from '../src/node-testing.js';
import { projectContractSchema } from '../src/schema-projection.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from '../src/workflow-authoring.js';
import { workflowDraftSaveRequestSchema } from '../src/http/workflow-authoring.js';
import {
  workflowPortabilityClientContract,
  workflowPortabilityOpenApiDocument,
} from '../src/workflow-portability.js';
import { workflowPortableManifestSchema } from '../src/http/workflow-portability.js';

function references(value: unknown, output: string[] = []): readonly string[] {
  if (value === null || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) references(item, output);
    return output;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.$ref === 'string') output.push(record.$ref);
  for (const nested of Object.values(record)) references(nested, output);
  return output;
}

function resolves(document: unknown, reference: string): boolean {
  if (!reference.startsWith('#/')) return reference === '#';
  let current = document;
  for (const encodedPart of reference.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return false;
    const part = encodedPart.replaceAll('~1', '/').replaceAll('~0', '~');
    current = (current as Readonly<Record<string, unknown>>)[part];
    if (current === undefined) return false;
  }
  return true;
}

describe('contract schema projection', () => {
  it('keeps recursive retained/native graph and portable manifest references local in both artifacts', () => {
    const body = {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: {},
      inputPorts: [],
      outputPorts: [],
    };
    const graph = {
      schemaVersion: 1,
      nodes: [
        {
          id: 'loop',
          definition: { key: 'for-each', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
          structured: {
            kind: 'for_each',
            maxIterations: 1,
            maxConcurrency: 1,
            body,
          },
        },
      ],
      edges: [],
      settings: {},
    };
    const nestedDescriptor = {
      type: 'object',
      properties: {
        child: {
          type: 'array',
          maxItems: 2,
          items: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      },
      required: ['child'],
    };
    const native = {
      ...graph,
      schemaVersion: 2,
      nodes: [
        {
          ...graph.nodes[0],
          structured: {
            kind: 'for_each',
            maxIterations: 1,
            maxConcurrency: 1,
            body: { ...body, schemaVersion: 2 },
          },
        },
      ],
      callable: {
        schemaVersion: 1,
        input: nestedDescriptor,
        result: nestedDescriptor,
        resultSelector: { kind: 'literal', value: {} },
      },
    };
    const manifest = {
      format: 'pertexo.workflow',
      formatVersion: 1,
      graph,
      requirements: {
        definitions: [],
        selectionFingerprint: `node-select:v1:sha256:${'a'.repeat(64)}`,
      },
      connectionSlots: [],
    };
    for (const [name, clientSchemas, openapiSchemas, runtimeSchema, values] of [
      [
        'WorkflowDraftSaveRequest',
        workflowAuthoringClientContract.schemas,
        workflowAuthoringOpenApiDocument.components.schemas,
        workflowDraftSaveRequestSchema,
        [{ graph }, { graph: native }],
      ],
      [
        'WorkflowPortableManifest',
        workflowPortabilityClientContract.schemas,
        workflowPortabilityOpenApiDocument.components.schemas,
        workflowPortableManifestSchema,
        [manifest],
      ],
    ] as const) {
      const client = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile({ $ref: `#/schemas/${name}`, schemas: clientSchemas });
      const openapi = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile({
        $ref: `#/components/schemas/${name}`,
        components: { schemas: openapiSchemas },
      });
      for (const value of values) {
        expect(runtimeSchema.safeParse(value).success).toBe(true);
        expect(client(value), JSON.stringify(client.errors)).toBe(true);
        expect(openapi(value), JSON.stringify(openapi.errors)).toBe(true);
      }
    }
  });
  it('retains portable manifest structural graph bounds and explicit runtime marker', () => {
    const manifest = workflowPortabilityClientContract.schemas
      .WorkflowPortableManifest as {
      properties?: { graph?: Record<string, unknown> };
    };
    expect(manifest).toMatchObject({
      type: 'object',
      'x-pertexo-runtime-bounds': true,
    });
    expect(manifest.properties?.graph).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        nodes: { type: 'array', maxItems: 1_000 },
        edges: { type: 'array', maxItems: 4_000 },
        settings: { type: 'object' },
      },
    });
    const document = { schemas: workflowPortabilityClientContract.schemas };
    for (const reference of references(document))
      expect(resolves(document, reference), reference).toBe(true);
  });
  it('keeps nested bounded-JSON definition ownership resolvable', () => {
    const document = {
      schemas: {
        NodeTestRequest: nodeTestingClientContract.schemas.NodeTestRequest,
      },
    };
    const localReferences = references(document);
    expect(localReferences.length).toBeGreaterThan(0);
    for (const reference of localReferences)
      expect(resolves(document, reference), reference).toBe(true);
  });

  it('rebases self references with escaped schema-name pointer segments', () => {
    const recursive: z.ZodType = z.lazy(() =>
      z.object({ 'child/~': recursive.optional() }).strict(),
    );
    const name = 'Recursive/~Contract';
    const projected = projectContractSchema(name, recursive, 'input', 'client');
    const document = { schemas: { [name]: projected } };
    expect(references(document)).toContain('#/schemas/Recursive~1~0Contract');
    for (const reference of references(document))
      expect(resolves(document, reference), reference).toBe(true);
  });

  it('retains the structural graph projection and explicit runtime marker', () => {
    const saveRequest = workflowAuthoringClientContract.schemas
      .WorkflowDraftSaveRequest as {
      properties?: { graph?: { anyOf?: Record<string, unknown>[] } };
    };
    const branches = saveRequest.properties?.graph?.anyOf;
    expect(branches).toHaveLength(2);
    for (const [index, branch] of (branches ?? []).entries())
      expect(branch).toMatchObject({
        type: 'object',
        'x-pertexo-runtime-bounds': true,
        additionalProperties: false,
        properties: {
          schemaVersion: { const: index + 1 },
          nodes: { type: 'array', maxItems: 1_000 },
          edges: { type: 'array', maxItems: 4_000 },
          settings: { type: 'object' },
        },
      });
    expect(branches?.[1]).toHaveProperty('properties.callable');
    expect(branches?.[1]).toMatchObject({
      properties: {
        callable: {
          type: 'object',
          additionalProperties: false,
          properties: {
            schemaVersion: { const: 1 },
            input: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { const: 'object' },
                properties: { type: 'object' },
                required: { type: 'array', maxItems: 128 },
              },
            },
            result: {
              type: 'object',
              additionalProperties: false,
              properties: { type: { const: 'object' } },
            },
          },
        },
      },
    });
    const document = { schemas: workflowAuthoringClientContract.schemas };
    for (const reference of references(document))
      expect(resolves(document, reference), reference).toBe(true);
  });
});
