import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dataTableValueSchema, dataTableValuesSchema } from '@pertexo/node-sdk';
import { boundedNodeTestJsonInputSchema } from '../src/schemas/shared/bounded-json-input.js';

import {
  nodeTestingClientContract,
  workflowAuthoringClientContract,
  workflowPortabilityClientContract,
} from '../src/server.js';
import { projectContractSchema } from '../src/openapi/schema-projection.js';

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
  it.each(['client', 'openapi'] as const)(
    'retains distinct bounded value projections for %s consumers',
    (target) => {
      const scalar = projectContractSchema(
        'Value',
        dataTableValueSchema,
        'input',
        target,
      );
      const values = projectContractSchema(
        'Values',
        dataTableValuesSchema,
        'input',
        target,
      );
      const input = projectContractSchema(
        'Input',
        boundedNodeTestJsonInputSchema,
        'input',
        target,
      );
      expect(Array.isArray(scalar.anyOf)).toBe(true);
      expect(scalar.description).toContain('64 KiB');
      expect(values.type).toBe('object');
      expect(typeof values.additionalProperties).toBe('object');
      expect(values.description).toContain('64 KiB');
      expect(input).toMatchObject({ 'x-pertexo-runtime-max-depth': 256 });
      for (const [name, projected] of Object.entries({
        Value: scalar,
        Values: values,
        Input: input,
      })) {
        const document =
          target === 'client'
            ? { schemas: { [name]: projected } }
            : { components: { schemas: { [name]: projected } } };
        for (const reference of references(projected))
          expect(resolves(document, reference), reference).toBe(true);
      }
    },
  );
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
        nodes: { type: 'array', maxItems: 200 },
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
      properties?: { graph?: Record<string, unknown> };
    };
    expect(saveRequest.properties?.graph).toMatchObject({
      type: 'object',
      'x-pertexo-runtime-bounds': true,
    });
    expect(saveRequest.properties?.graph?.properties).toMatchObject({
      nodes: { type: 'array', maxItems: 200 },
      edges: { type: 'array', maxItems: 4_000 },
      settings: { type: 'object' },
    });
  });

  // The published description must state the limits the runtime enforces.
  it('describes the data-table value limits the runtime enforces', () => {
    for (const schema of [dataTableValueSchema, dataTableValuesSchema])
      expect(
        projectContractSchema('Value', schema, 'input', 'openapi').description,
      ).toBe(
        'Runtime validation checks JSON depth (32), members (8,000) and bytes (64 KiB) before recursive parsing.',
      );
    const nested = (depth: number) => {
      let value: unknown = null;
      for (let index = 0; index < depth; index += 1) value = [value];
      return value;
    };
    const accepts = (value: unknown) =>
      dataTableValueSchema.safeParse(value).success;
    expect([accepts(nested(32)), accepts(nested(33))]).toEqual([true, false]);
    expect([
      accepts(Array.from({ length: 8_000 }, () => 0)),
      accepts(Array.from({ length: 8_001 }, () => 0)),
    ]).toEqual([true, false]);
    // A string's JSON form adds two quote bytes.
    expect([
      accepts('a'.repeat(65_536 - 2)),
      accepts('a'.repeat(65_536 - 1)),
    ]).toEqual([true, false]);
  });
});
