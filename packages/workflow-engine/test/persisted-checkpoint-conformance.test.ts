import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseCheckpoint } from '../src/checkpoint.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000101';
const mergeKey = `${workflowVersionId}|merge|b:|i:`;
const joinConformanceCases = JSON.parse(
  readFileSync(
    new URL(
      '../../database/test/fixtures/checkpoint-join-conformance.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as unknown as readonly Readonly<{
  name: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  join: Readonly<Record<string, unknown>>;
}>[];

function checkpoint(
  join: Readonly<Record<string, unknown>>,
  status: 'pending' | 'succeeded' | 'failed' | 'canceled',
) {
  return {
    schemaVersion: 2,
    engineVersion: 'engine-v1',
    workflowVersionId,
    revision: 1,
    runStatus: status === 'failed' ? 'failed' : 'running',
    nextEventSequence: 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [
      {
        invocationKey: mergeKey,
        nodeId: 'merge',
        status,
        attemptNumber: 0,
        branchPath: [],
        iterationPath: [],
      },
    ],
    joins: [
      {
        joinInvocationKey: mergeKey,
        joinId: 'merge',
        branchPath: [],
        iterationPath: [],
        ...join,
      },
    ],
    loops: [],
    branchSelections: [],
    remainingIterationBudget: 1_000,
    cancelRequested: false,
    deadlineExpired: false,
  };
}

describe('database and engine checkpoint conformance fixtures', () => {
  it.each(joinConformanceCases)('accepts $name', ({ join, status }) => {
    expect(parseCheckpoint(checkpoint(join, status))).toMatchObject({
      joins: [expect.objectContaining({ joinId: 'merge' })],
    });
  });
});
