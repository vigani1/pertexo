import type {
  WorkflowGraphContract,
  WorkflowValidateResponse,
} from '@pertexo/contracts';
import { describe, expect, it } from 'vitest';
import { commandErrorMessage } from '@/features/workflow-publish/data/mutations/workflow-command-feedback';
import { groupWorkflowIssues } from '@/features/workflow-publish/model/validation/issues';
import { ApiError } from '@/lib/api/error';

const step = (id: string, label: string) => ({
  id,
  label,
  definition: { key: 'http.request', version: 1 },
  configVersion: 1,
  config: { timeoutMillis: 300_000 },
  inputMappings: {},
  connectionRefs: {},
  position: { x: 0, y: 0 },
});

const graph = {
  nodes: [
    step('fetch', 'Fetch orders'),
    {
      ...step('loop', 'Each order'),
      definition: { key: 'core.foreach', version: 1 },
      structured: {
        kind: 'for_each',
        maxIterations: 2,
        maxConcurrency: 1,
        body: {
          settings: {},
          nodes: [step('inner', 'Fetch one order')],
          edges: [],
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
        },
      },
    },
  ],
  edges: [],
  settings: {},
} as unknown as WorkflowGraphContract;

/** The report the real API gives for a timeout past its limit. */
const report = (path: string, code: string, message: string) =>
  ({
    valid: false,
    issues: [{ path, code, message }],
    compatibility: { compatible: true, fingerprint: 'f', issues: [] },
    currentPublication: null,
  }) as unknown as WorkflowValidateResponse;

const TOO_BIG = 'timeoutMillis: Too big: expected number to be <=120000';

describe('settings a run could only refuse, on the page', () => {
  it('lands on the step, with its field, so Fix opens it', () => {
    const groups = groupWorkflowIssues(
      report('$.nodes.fetch.config.timeoutMillis', 'invalid_graph', TOO_BIG),
      graph,
    );
    expect(groups).toMatchObject([
      {
        nodeId: 'fetch',
        issues: [
          {
            message: expect.stringContaining('120000') as string,
            target: { nodeId: 'fetch' },
          },
        ],
      },
    ]);
  });

  it('lands on the step inside a For each, not on the For each', () => {
    const groups = groupWorkflowIssues(
      report(
        '$.nodes.loop.structured.body.nodes.inner.config.timeoutMillis',
        'invalid_graph',
        TOO_BIG,
      ),
      graph,
    );
    expect(groups.map(({ nodeId }) => nodeId)).toEqual(['inner']);
  });

  it('keeps the words that name the step when the check publish makes finds it', () => {
    const message =
      "Fetch orders has settings it can't run with. Open the step and check its values against their limits";
    const groups = groupWorkflowIssues(
      report('$.nodes.fetch.config', 'invalid_step_settings', message),
      graph,
    );
    expect(groups).toMatchObject([
      { nodeId: 'fetch', issues: [{ message: `${message}.` }] },
    ]);
  });

  it('gives the refusal its reason when publishing is stopped', () => {
    const refused = new ApiError({
      kind: 'problem',
      message: 'Request failed',
      status: 422,
      problem: {
        type: 'urn:pertexo:problem:workflow.invalid',
        title: 'Invalid workflow',
        status: 422,
        code: 'workflow.invalid',
        requestId: 'settings',
        errors: [
          {
            path: '$.nodes.fetch.config.timeoutMillis',
            code: 'invalid_graph',
            message: TOO_BIG,
          },
        ],
      },
    });
    expect(commandErrorMessage(refused, 'publishing')).toBe(TOO_BIG);
  });
});
