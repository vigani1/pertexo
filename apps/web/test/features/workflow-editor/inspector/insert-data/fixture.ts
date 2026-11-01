import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  parseJsonPath,
  parseWorkflowGraphDraft,
  validateWorkflowGraph,
} from '@pertexo/workflow-model';
import { JsonataEvaluator } from '@pertexo/workflow-model/server';
import { screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterAll } from 'vitest';
import {
  link,
  type openEditor,
  step,
  type GraphNode,
} from '../../../../support/fixtures/inspector-session';
import {
  api,
  workflowApi,
  workflowId,
  workspaceId,
} from '../../../../support/fixtures/workflow-editor';

export const evaluator = new JsonataEvaluator();
afterAll(() => evaluator.shutdown());

export const formStep = () =>
  step('form', 'core.form', 'Leave form', {
    config: {
      title: 'Ask for leave',
      instructions: '',
      fields: [
        {
          id: 'field-name',
          name: 'name',
          label: 'Your name',
          type: 'text',
          help: '',
          required: true,
        },
        {
          id: 'field-days',
          name: 'days',
          label: 'Days off',
          type: 'number',
          help: '',
          required: true,
        },
      ],
    },
  });

/** Start, then Fetch, then Middle, then Target: Fetch is one step too far back. */
export function chain(targetMappings: GraphNode['inputMappings'] = {}) {
  return {
    nodes: [
      step('manual', 'core.manual', 'Start'),
      step('fetch', 'core.set', 'Fetch order'),
      step('middle', 'core.set', 'Middle'),
      step('target', 'core.set', 'Target', { inputMappings: targetMappings }),
    ],
    edges: [
      link('manual', 'fetch'),
      link('fetch', 'middle'),
      link('middle', 'target'),
    ],
    settings: {},
  } satisfies WorkflowGraphContract;
}

/** Fetch feeds Target directly. */
export function direct(targetMappings: GraphNode['inputMappings'] = {}) {
  return {
    nodes: [
      step('manual', 'core.manual', 'Start'),
      step('fetch', 'core.set', 'Fetch order'),
      step('target', 'core.set', 'Target', { inputMappings: targetMappings }),
    ],
    edges: [link('manual', 'fetch'), link('fetch', 'target')],
    settings: {},
  } satisfies WorkflowGraphContract;
}

export type Session = Awaited<ReturnType<typeof openEditor>>;

export async function openPicker(session: Session, label = 'Target') {
  session.select(label);
  await session.event.click(await screen.findByRole('tab', { name: 'Inputs' }));
  await session.event.click(
    await screen.findByRole('button', { name: 'Insert data' }),
  );
  return within(await screen.findByRole('dialog', { name: 'Insert data' }));
}

/** The engine's own check of a saved graph. */
export function mappingIssues(graph: WorkflowGraphContract | undefined) {
  const parsed = parseWorkflowGraphDraft(graph);
  return validateWorkflowGraph(parsed).issues.map((issue) => issue.code);
}

export const walk = (value: unknown, path: string) =>
  (parseJsonPath(path) ?? []).reduce<unknown>(
    (current, part) =>
      (current as Record<string | number, unknown> | undefined)?.[part],
    value,
  );

const runId = '12121212-1212-4212-8212-121212121212';
const nodeRunId = '34343434-3434-4434-8434-343434343434';
const otherRunId = '56565656-5656-4656-8656-565656565656';
const otherNodeRunId = '78787878-7878-4878-8878-787878787878';
const versionId = '90909090-9090-4090-8090-909090909090';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runs = `${api}/workspaces/${workspaceId}/runs`;
export const at = '2026-10-16T10:00:00.000Z';

/** The latest workflow test, in which Fetch returned `source: 'workflow test'`. */
export function workflowTestHandlers(nodeId = 'fetch') {
  return [
    http.get(`${workflowApi}/draft/tests`, () =>
      HttpResponse.json({
        items: [
          {
            runId,
            startedBy: userId,
            draftRevision: 1,
            status: 'succeeded',
            createdAt: at,
            expiresAt: '2026-11-16T10:00:00.000Z',
          },
        ],
      }),
    ),
    http.get(`${runs}/${runId}`, () =>
      HttpResponse.json({
        run: {
          id: runId,
          workspaceId,
          workflowId,
          workflowVersionId: versionId,
          status: 'succeeded',
          triggerType: 'manual',
          createdAt: at,
          updatedAt: at,
          startedAt: at,
          completedAt: at,
          deadlineAt: null,
          cancelRequestedAt: null,
        },
        nodes: [
          {
            id: nodeRunId,
            nodeId,
            invocationKey: nodeId,
            status: 'succeeded',
            currentAttemptNumber: 1,
            startedAt: at,
            completedAt: at,
            resumeAt: null,
            safeErrorCode: null,
          },
        ],
        calls: [],
      }),
    ),
    http.get(`${runs}/${runId}/node-runs/${nodeRunId}/output`, () =>
      HttpResponse.json({
        output: { kind: 'inline', value: { source: 'workflow test' } },
      }),
    ),
  ];
}

/** Fetch's latest real run, which returned `output`. */
export function realRunHandlers(
  output: Record<string, unknown> = {
    kind: 'inline',
    value: { source: 'real run' },
  },
) {
  return [
    http.get(`${workflowApi}/steps/fetch/runs`, () =>
      HttpResponse.json({
        items: [
          {
            runId: otherRunId,
            runStatus: 'succeeded',
            runCreatedAt: at,
            workflowVersionId: versionId,
            nodeRunId: otherNodeRunId,
            invocationKey: 'fetch',
            status: 'succeeded',
            attempts: 1,
            startedAt: at,
            completedAt: at,
            safeErrorCode: null,
          },
        ],
      }),
    ),
    http.get(`${runs}/${otherRunId}/node-runs/${otherNodeRunId}/output`, () =>
      HttpResponse.json({ output }),
    ),
  ];
}

export function stepTestHandler(nodeId: string, value: unknown) {
  return http.post(`${workflowApi}/draft/nodes/${nodeId}/test`, () =>
    HttpResponse.json(
      {
        mode: 'test_execute',
        replayed: false,
        preview: {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          workspaceId,
          workflowId,
          draftRevision: 1,
          nodeId,
          status: 'succeeded',
          disclosure: {
            sideEffectClass: 'safe',
            mayContactProvider: false,
            mayCauseExternalSideEffect: false,
            dryRun: 'not_supported',
          },
          output: { kind: 'inline', value },
          safeErrorCode: null,
          createdAt: at,
          startedAt: at,
          completedAt: at,
          expiresAt: '2026-11-16T10:00:00.000Z',
        },
      },
      { status: 202 },
    ),
  );
}

export async function runStepTest(session: Session, label: string) {
  session.select(label);
  await session.event.click(await screen.findByRole('tab', { name: 'Test' }));
  await session.event.click(
    screen.getByRole('switch', {
      name: 'I understand this test runs for real',
    }),
  );
  await session.event.click(screen.getByRole('button', { name: 'Run test' }));
  await screen.findByRole('region', { name: 'Last test' });
}
