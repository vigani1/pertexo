import { randomUUID } from 'node:crypto';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { GUARDRAILS_STEP } from '@pertexo/workflow-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { createCoordinatorRecoveryHarness } from '../../support/coordinator/recovery-harness.js';
import { acceptFixtureRun } from '../../support/coordinator/runs/accept.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import {
  edgesFromTuples,
  manualNode,
  setNode,
} from '../../support/coordinator/workflows/nodes.js';

const sentinel = 'f63-private-sentinel@example.test';

describe.skipIf(!fixture.enabled)('published Guardrails workflow', () => {
  beforeAll(fixture.setup);
  afterAll(fixture.restoreServicesAndClose);

  it.each([
    ['pass', 'Proceed with the request.'],
    ['fail', sentinel],
  ])(
    'selects %s and completes the enclosing Merge without storing Guardrails text',
    async (port, message) => {
      const workflowId = randomUUID();
      const workflowVersionId = randomUUID();
      await insertCompiledWorkflow(fixture.ownerQuery, {
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        identity: { workflowId, workflowVersionId },
        name: `Guardrails ${port} and Merge`,
        catalog: PLATFORM_NODE_CATALOG,
        graph: {
          settings: { maxRunDurationMs: 60_000 },
          nodes: [
            manualNode,
            {
              ...setNode('parallel', 0),
              definition: { key: 'core.parallel', version: 1 },
              config: {
                branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
                maxConcurrency: 2,
              },
              inputMappings: {},
            },
            {
              ...setNode('guardrails', 0),
              definition: GUARDRAILS_STEP,
              config: { checks: [{ kind: 'pii' }] },
              inputMappings: { text: { kind: 'run_input', path: '$.message' } },
            },
            setNode('pass', -10),
            setNode('fail', 10),
            {
              ...setNode('join', 0),
              definition: { key: 'core.merge', version: 1 },
              config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
              inputMappings: {},
            },
          ],
          // As in Classify, only one route can feed an enclosing Parallel
          // branch's Merge input. Both Guardrails routes are still wired.
          edges: edgesFromTuples([
            ['manual-parallel', 'manual', 'out', 'parallel', 'in'],
            [
              'parallel-guardrails',
              'parallel',
              'branch-01',
              'guardrails',
              'in',
            ],
            ['parallel-join', 'parallel', 'branch-02', 'join', 'branch-02'],
            ['pass-route', 'guardrails', 'pass', 'pass', 'in'],
            ['fail-route', 'guardrails', 'fail', 'fail', 'in'],
            ['route-join', port, 'out', 'join', 'branch-01'],
          ]),
        },
      });
      const accepted = await acceptFixtureRun({
        workflowId,
        workflowVersionId,
        iterationBudget: 0,
        runInput: { message },
      });
      const harness = await createCoordinatorRecoveryHarness({
        accepted,
        database: parseDatabaseConfig({
          connectionString: fixture.databaseUrl(fixture.workerUrl),
          max: 6,
        }),
        runtimeCapabilities: {},
        workerIdPrefix: 'guardrails',
      });
      try {
        await harness.publishCoordinator(accepted.outboxEventId, 1);
        await harness.executeNext('manual');
        await harness.continueAfter(2);
        await harness.executeNext('parallel');
        await harness.continueAfter(3);
        await harness.executeNext('guardrails');
        await harness.continueAfter(4);
        await harness.executeNext(port);
        await harness.continueAfter(5);
        await harness.executeNext('join');
        await harness.continueAfter(6);
        const [run] = await fixture.workerQuery<{ status: string }>(
          'select status from app.workflow_runs where id=$1',
          [accepted.runId],
        );
        expect(run?.status).toBe('succeeded');
        const steps = await fixture.workerQuery<{
          node_id: string;
          status: string;
          input_ref: unknown;
          output_ref: unknown;
          diagnostics: unknown;
        }>(
          `select node.node_id,node.status,node.input_ref,node.output_ref,attempt.diagnostics
           from app.node_runs node
           left join app.node_attempts attempt
             on attempt.workspace_id=node.workspace_id and attempt.id=node.current_attempt_id
          where node.workspace_id=$1 and node.workflow_run_id=$2 and node.node_id <> 'manual'`,
          [fixture.workspaceId, accepted.runId],
        );
        expect(
          steps
            .filter(({ status }) => status === 'succeeded')
            .map(({ node_id }) => node_id)
            .sort(),
        ).toEqual(['guardrails', 'join', 'parallel', port].sort());
        expect(steps.find(({ node_id }) => node_id === 'guardrails')).toEqual({
          node_id: 'guardrails',
          status: 'succeeded',
          input_ref: null,
          output_ref: { kind: 'inline', value: { selectedPort: port } },
          diagnostics: {
            kind: 'guardrails',
            reasons: port === 'pass' ? {} : { 'pii.email': 1 },
          },
        });
        expect(JSON.stringify(steps)).not.toContain(sentinel);
      } finally {
        await harness.close();
      }
    },
  );
});
