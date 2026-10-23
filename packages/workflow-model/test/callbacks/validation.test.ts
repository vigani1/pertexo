import { expect, it } from 'vitest';
import {
  callbackReferenceIssue,
  callbackTargetNodes,
  callbackMappingExpression,
} from '../../src/flow/callbacks/validation.js';
const sender = {
  id: 'send',
  definition: { key: 'http.request', version: 1 },
  config: {},
};
const wait = {
  id: 'wait-1',
  definition: { key: 'core.wait', version: 1 },
  config: {
    mode: 'callback',
    timeoutSeconds: 60,
    authentication: { mode: 'secret_url', allowedOrigins: [] },
  },
};
const graph = {
  nodes: [sender, wait],
  edges: [{ source: { nodeId: 'send' }, target: { nodeId: 'wait-1' } }],
};
it('offers only configured enabled callback Waits reachable on this graph level', () => {
  expect(callbackTargetNodes(graph, 'send')).toEqual([wait]);
  expect(
    callbackTargetNodes(
      { ...graph, nodes: [sender, { ...wait, disabled: true }] },
      'send',
    ),
  ).toEqual([]);
  expect(callbackTargetNodes({ ...graph, edges: [] }, 'send')).toEqual([]);
  expect(
    callbackTargetNodes(
      {
        ...graph,
        nodes: [sender, { ...wait, config: { durationSeconds: 60 } }],
      },
      'send',
    ),
  ).toEqual([]);
  expect(callbackMappingExpression('wait-1', 'url')).toBe(
    '$lookup($execution.callbacks,"wait-1").url',
  );
});
it('rejects data-step delivery, missing targets and a secret for URL-only authentication', () => {
  const refs = [{ nodeId: 'wait-1', field: 'url' as const }];
  expect(
    callbackReferenceIssue(refs, graph, 'send', { externalHttp: true }),
  ).toBeUndefined();
  expect(
    callbackReferenceIssue(refs, graph, 'send', { externalHttp: false }),
  ).toMatch(/not saved/u);
  expect(
    callbackReferenceIssue(refs, { ...graph, edges: [] }, 'send', {
      externalHttp: true,
    }),
  ).toMatch(/same workflow or loop body/u);
  expect(
    callbackReferenceIssue(
      [{ nodeId: 'wait-1', field: 'secret' }],
      graph,
      'send',
      { externalHttp: true },
    ),
  ).toMatch(/secret URL only/u);
});
it('bounds prepared identities per sender and leaves ordinary mappings alone', () => {
  expect(
    callbackReferenceIssue(
      Array.from({ length: 17 }, (_, i) => ({
        nodeId: `wait-${String(i)}`,
        field: 'url' as const,
      })),
      graph,
      'send',
      { externalHttp: true },
    ),
  ).toMatch(/at most 16/u);
  expect(
    callbackReferenceIssue([], undefined, undefined, { externalHttp: false }),
  ).toBeUndefined();
});
