import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { nodeTestingClientContract } from '../src/node-testing.js';
import { projectContractSchema } from '../src/schema-projection.js';
import { workflowAuthoringClientContract } from '../src/workflow-authoring.js';

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
      nodes: { type: 'array', maxItems: 1_000 },
      edges: { type: 'array', maxItems: 4_000 },
      settings: { type: 'object' },
    });
  });
});
