import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkflowRunDatabase } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  fixture,
  node,
  edge,
  publishGraph,
  accept,
  runtime,
} from './calls/calls.fixture.js';

describe.runIf(fixture.enabled)('Persisted mapping diagnostics', () => {
  beforeAll(fixture.setup, 60000);
  afterAll(fixture.restoreServicesAndClose);
  it.each([
    [
      { kind: 'workspace_variable', name: 'ABSENT' },
      'execution.variable_missing',
      'Input "total" uses missing workspace variable "ABSENT". Add it in Settings → Variables or update this mapping.',
    ],
    [
      { kind: 'expression', language: 'jsonata', expression: '1 / 0' },
      'execution.expression_failed',
      'Expression for field "total" returned a nonfinite number. Reduce the numeric result or check for division by zero.',
    ],
  ] as const)(
    'fails with a retained safe reason for %j',
    async (source, safeErrorCode, errorSummary) => {
      const version = await publishGraph({
        settings: { maxRunDurationMs: 60000 },
        nodes: [
          node('manual', 'core.manual'),
          {
            ...node('calculate', 'core.set'),
            inputMappings: {
              harmless: { kind: 'literal', value: 'kept' },
              total: source,
            },
          },
        ],
        edges: [edge('manual', 'calculate')],
      });
      const run = await accept(version);
      const workers = await runtime();
      const reader = createWorkflowRunDatabase(
        parseDatabaseConfig({
          connectionString: fixture.databaseUrl(fixture.workerUrl),
          max: 2,
        }),
      );
      try {
        await workers.until(async () => {
          expect(
            await fixture.workerQuery(
              'select status from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([{ status: 'failed' }]);
        });
        const shown = await reader.get({
          workspaceId: fixture.workspaceId,
          actorId: fixture.actorId,
          runId: run.runId,
          signal: new AbortController().signal,
        });
        expect(
          shown?.nodes.find((step) => step.nodeId === 'calculate'),
        ).toMatchObject({ status: 'failed', safeErrorCode, errorSummary });
        expect(
          await fixture.workerQuery(
            'select attempt.status,attempt.safe_error_code,attempt.error_summary from app.node_attempts attempt join app.node_runs step on step.id=attempt.node_run_id where step.workflow_run_id=$1 and step.node_id=$2',
            [run.runId, 'calculate'],
          ),
        ).toEqual([
          {
            status: 'failed',
            safe_error_code: safeErrorCode,
            error_summary: errorSummary,
          },
        ]);
      } finally {
        await Promise.all([workers.close(), reader.close()]);
      }
    },
    30000,
  );
});
