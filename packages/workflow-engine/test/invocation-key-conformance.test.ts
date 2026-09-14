import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { invocationKey } from '../src/index.js';

const invocationKeyCases = JSON.parse(
  readFileSync(
    new URL(
      '../../database/test/fixtures/invocation-key-conformance.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as unknown as readonly Readonly<{
  expected: string;
  input: Readonly<{
    branchPath?: readonly Readonly<{ nodeId: string; outputPort: string }>[];
    iterationPath?: readonly Readonly<{
      loopNodeId: string;
      ordinal: number;
    }>[];
    nodeId: string;
    workflowVersionId: string;
  }>;
  name: string;
}>[];

describe('database and engine invocation-key conformance fixtures', () => {
  it.each(invocationKeyCases)(
    'keeps the $name encoding byte-compatible',
    ({ expected, input }) => {
      const branchPath = input.branchPath?.map(
        ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
      );
      expect(
        invocationKey({
          workflowVersionId: input.workflowVersionId,
          nodeId: input.nodeId,
          ...(branchPath === undefined ? {} : { branchPath }),
          ...(input.iterationPath === undefined
            ? {}
            : { iterationPath: input.iterationPath }),
        }),
      ).toBe(expected);
    },
  );
});
