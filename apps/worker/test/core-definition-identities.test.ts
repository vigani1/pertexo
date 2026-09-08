import { parseCheckpoint } from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';

import { createWorkerInitialCheckpoint } from '../src/execution/core-definition-identities.js';

describe('worker core definition checkpoint selection', () => {
  it('starts For Each executions with the structured checkpoint schema', () => {
    const executable = {
      envelope: {
        graph: {
          nodes: [
            { definition: { key: 'core.manual', version: 1 } },
            { definition: { key: 'core.foreach', version: 1 } },
          ],
        },
      },
    } as never;

    const initial = createWorkerInitialCheckpoint(
      executable,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    expect(parseCheckpoint(initial.checkpoint)).toMatchObject({
      branchSelections: [],
      schemaVersion: 2,
    });
  });
});
