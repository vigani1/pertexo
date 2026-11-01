import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
  type CompiledWorkflowExecutable,
} from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';

import { RUN_ID, VERSION_ID } from '../support/workflow.fixture.js';

const at = '2026-10-30T00:00:00.000Z';
const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);

// The engine schedules Switch and Parallel by the output ports nodes-core
// publishes. Every port a published definition offers must run, so the two
// can't drift apart.
describe('control ports published by the core definitions', () => {
  it('runs every branch a Parallel can publish', async () => {
    const ports = outputPorts('core.parallel');
    const run = await startRun(
      workflow({
        key: 'core.parallel',
        config: {
          branches: ports.map((id) => ({ id })),
          maxConcurrency: ports.length,
        },
        ports,
        merge: true,
      }),
    );
    await run.succeed('manual');
    const plan = await run.succeed('control', { branchIds: ports });
    expect(
      plan.checkpoint.invocations
        .filter(({ nodeId }) => nodeId.startsWith('after-'))
        .map(({ nodeId, status }) => [nodeId, status])
        .sort(),
    ).toEqual(ports.map((port) => [`after-${port}`, 'running']).sort());
  });

  it('routes to every case a Switch can publish', async () => {
    const cases = outputPorts('core.switch').filter(
      (port) => port !== 'default',
    );
    for (const selected of cases) {
      const run = await startRun(
        workflow({
          key: 'core.switch',
          config: {
            cases: cases.map((id, index) => ({ id, equals: index })),
          },
          ports: [...cases, 'default'],
        }),
      );
      await run.succeed('manual');
      const plan = await run.succeed('control', { selectedPort: selected });
      expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual([
        `after-${selected}`,
      ]);
    }
  });
});

function outputPorts(key: string): readonly string[] {
  const definition = CORE_NODE_CATALOG.definitions.find(
    ({ definition }) => definition.key === key,
  );
  if (definition === undefined) throw new Error(`${key} is not published`);
  return definition.ports.outputs;
}

function workflow({
  key,
  config,
  ports,
  merge = false,
}: Readonly<{
  key: string;
  config: Record<string, unknown>;
  ports: readonly string[];
  merge?: boolean;
}>) {
  const node = (id: string, definitionKey: string, x: number) => ({
    id,
    definition: { key: definitionKey, version: 1 },
    position: { x, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  });
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual', 0),
      { ...node('control', key, 10), config },
      ...ports.map((port) => node(`after-${port}`, 'core.set', 20)),
      ...(merge
        ? [
            {
              ...node('merge', 'core.merge', 30),
              config: { parallelNodeId: 'control', policy: { kind: 'all' } },
            },
          ]
        : []),
    ],
    edges: [
      {
        id: 'manual-control',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'control', port: 'in' },
      },
      ...ports.map((port) => ({
        id: `control-${port}`,
        source: { nodeId: 'control', port },
        target: { nodeId: `after-${port}`, port: 'in' },
      })),
      ...(merge
        ? ports.map((port) => ({
            id: `after-${port}-merge`,
            source: { nodeId: `after-${port}`, port: 'out' },
            target: { nodeId: 'merge', port },
          }))
        : []),
    ],
  };
}

async function startRun(graph: ReturnType<typeof workflow>) {
  const executable: CompiledWorkflowExecutable = buildWorkflowExecutable({
    graph,
    catalog,
  });
  let checkpoint: unknown = createCheckpoint({
    workflowVersionId: VERSION_ID,
    iterationBudget: 0,
  });
  let attempt = 0;
  const advance = async (
    input: Readonly<{ observations?: unknown; completedOutputs?: unknown }>,
  ) => {
    const plan = await advanceWorkflow({
      runId: RUN_ID,
      executable,
      workflowVersionId: VERSION_ID,
      checkpoint,
      ...input,
      occurredAt: at,
      maximumAdmissions: 32,
      signal: new AbortController().signal,
    });
    checkpoint = plan.checkpoint;
    return plan;
  };
  let { nextEventSequence } = (await advance({})).checkpoint;
  return {
    async succeed(nodeId: string, value?: unknown) {
      const sequence = nextEventSequence;
      attempt += 1;
      const attemptId = `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`;
      const key = invocationKey({ workflowVersionId: VERSION_ID, nodeId });
      const plan = await advance({
        observations: [
          {
            sequence,
            occurredAt: at,
            attemptId,
            attemptNumber: 1,
            kind: 'outcome',
            invocationKey: key,
            status: 'succeeded',
            output: { kind: 'inline', attemptId },
          },
        ],
        ...(value === undefined
          ? {}
          : {
              completedOutputs: [
                { sequence, attemptId, invocationKey: key, value },
              ],
            }),
      });
      nextEventSequence = plan.checkpoint.nextEventSequence;
      return plan;
    },
  };
}
