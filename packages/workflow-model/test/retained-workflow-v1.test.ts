import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  parseRetainedWorkflowVersionV1,
  workflowRetainedExecutableChecksum,
} from '../src/graph.js';

async function retainedFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL('./fixtures/retained-workflow-v1.json', import.meta.url),
      'utf8',
    ),
  ) as unknown;
}

describe('retained workflow V1 compatibility', () => {
  it('verifies the golden V1 checksum byte-for-byte and remains non-executable', async () => {
    const retained = parseRetainedWorkflowVersionV1(await retainedFixture());

    expect(retained).toEqual({
      format: 'v1',
      executable: false,
      graphSchemaVersion: 1,
      graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
      checksum:
        'wf:v1:sha256:867eb2ddb537de897b2bd347fdd786efc54b4132e4f7e956dc7ad37a3b0bebc8',
    });
    expect(workflowRetainedExecutableChecksum(retained.graph)).toBe(
      retained.checksum,
    );
  });

  it('fails closed on checksum corruption or executable-envelope data', async () => {
    const fixture = (await retainedFixture()) as Record<string, unknown>;

    expect(() =>
      parseRetainedWorkflowVersionV1({
        ...fixture,
        checksum: `wf:v1:sha256:${'0'.repeat(64)}`,
      }),
    ).toThrow(/checksum/i);
    expect(() =>
      parseRetainedWorkflowVersionV1({
        ...fixture,
        executableSchemaVersion: 2,
        executableJson: {},
        compatibilityReleaseEpoch: 1,
      }),
    ).toThrow();
  });

  it('rejects unknown checksum formats and malformed retained graphs safely', async () => {
    const fixture = (await retainedFixture()) as Record<string, unknown>;

    expect(() =>
      parseRetainedWorkflowVersionV1({
        ...fixture,
        checksum: `wf:v2:sha256:${'0'.repeat(64)}`,
      }),
    ).toThrow();
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 500; index += 1) deep = { child: deep };
    expect(() =>
      parseRetainedWorkflowVersionV1({
        ...fixture,
        graphJson: {
          schemaVersion: 1,
          nodes: [],
          edges: [],
          settings: deep,
        },
      }),
    ).toThrow();
  });
});
