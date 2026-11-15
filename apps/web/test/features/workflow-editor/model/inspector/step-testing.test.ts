import { describe, expect, it } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import {
  listensForTestRequests,
  previewUnavailable,
  priorTestFor,
} from '@/features/workflow-editor/model/inspector/step-testing';

function step(id: string, key: string, inputMappings = {}) {
  return {
    id,
    label: `Step ${id}`,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    config: {},
    inputMappings,
  };
}

/* A focused graph: the rules read node keys, labels, mappings and edges. */
function graph(
  edges: readonly Readonly<{ from: string; port?: string; to: string }>[],
): WorkflowGraphContract {
  return {
    nodes: [step('fetch', 'core.http_request'), step('send', 'core.set')],
    edges: edges.map(({ from, port = 'success', to }, index) => ({
      id: `e${String(index)}`,
      source: { nodeId: from, port },
      target: { nodeId: to, port: 'in' },
    })),
    settings: {},
  } as unknown as WorkflowGraphContract;
}

describe('which earlier test can feed a step', () => {
  const passed = { previewId: 'p1', nodeId: 'fetch' };

  it('offers a passed test of a step wired straight into this one', () => {
    expect(
      priorTestFor(graph([{ from: 'fetch', to: 'send' }]), passed, 'send'),
    ).toEqual({ id: 'p1', stepName: 'Step fetch' });
  });

  it('offers nothing through the failure port, or without a link or a test', () => {
    expect(
      priorTestFor(
        graph([{ from: 'fetch', port: WORKFLOW_FAILURE_PORT, to: 'send' }]),
        passed,
        'send',
      ),
    ).toBeUndefined();
    expect(priorTestFor(graph([]), passed, 'send')).toBeUndefined();
    expect(
      priorTestFor(graph([{ from: 'fetch', to: 'send' }]), undefined, 'send'),
    ).toBeUndefined();
  });
});

describe('which steps a single-step preview cannot test', () => {
  it('names the approval, the call and a failure handler, and nothing else', () => {
    expect(previewUnavailable(step('a', 'core.approval') as never)).toMatch(
      /decide it in Approvals/u,
    );
    expect(previewUnavailable(step('c', 'core.call') as never)).toMatch(
      /test the Call with its child/u,
    );
    expect(
      previewUnavailable(
        step('h', 'core.set', {
          failure: { kind: 'node_failure', nodeId: 'fetch' },
        }) as never,
      ),
    ).toMatch(/reads an actual failure/u);
    expect(previewUnavailable(step('s', 'core.set') as never)).toBeUndefined();
    expect(previewUnavailable(undefined)).toBeUndefined();
  });
});

it('listens for a real test request only on a Webhook step', () => {
  expect(listensForTestRequests(step('w', 'core.webhook') as never)).toBe(true);
  expect(listensForTestRequests(step('s', 'core.set') as never)).toBe(false);
  expect(listensForTestRequests(undefined)).toBe(false);
});
