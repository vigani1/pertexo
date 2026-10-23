import { describe, expect, it } from 'vitest';

import { EMPTY_WORKFLOW_GRAPH } from '../../src/graph/contract.js';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
  workflowIntegrationUsage,
} from '../../src/graph/identity.js';

import {
  TEST_DEFINITION_CATALOG,
  node,
  fixture,
} from '../support/graph-contract.js';
describe('workflow integration usage projection', () => {
  const catalog = {
    definitions: [
      {
        key: 'core.set',
        version: 1,
        integration: {
          providerKey: 'http',
          operationKey: 'request',
          connectionSlots: ['primary'],
        },
      },
    ],
  };

  it('derives, deduplicates, and sorts nested provider operation connections', () => {
    const nested = node('nested');
    const outer = {
      ...node('outer'),
      connectionRefs: { primary: 'connection-2' },
      structured: {
        kind: 'for_each' as const,
        maxIterations: 2,
        maxConcurrency: 1,
        body: {
          nodes: [nested],
          edges: [],
          settings: {},
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };

    expect(
      workflowIntegrationUsage(
        { ...EMPTY_WORKFLOW_GRAPH, nodes: [outer, node('duplicate')] },
        catalog,
      ),
    ).toEqual([
      {
        providerKey: 'http',
        operationKey: 'request',
        connectionId: 'connection-1',
      },
      {
        providerKey: 'http',
        operationKey: 'request',
        connectionId: 'connection-2',
      },
    ]);
  });

  it('fails closed when catalog metadata names an absent connection slot', () => {
    expect(() =>
      workflowIntegrationUsage(
        {
          ...EMPTY_WORKFLOW_GRAPH,
          nodes: [{ ...node('missing'), connectionRefs: {} }],
        },
        catalog,
      ),
    ).toThrow(/requires connection slot primary/u);
  });

  it('records no connection for a disabled step or the loop inside it', () => {
    const disabledLoop = {
      ...node('loop'),
      disabled: true,
      structured: {
        kind: 'for_each' as const,
        maxIterations: 2,
        maxConcurrency: 1,
        body: {
          nodes: [{ ...node('inside'), connectionRefs: {} }],
          edges: [],
          settings: {},
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };
    expect(
      workflowIntegrationUsage(
        {
          ...EMPTY_WORKFLOW_GRAPH,
          nodes: [
            { ...node('off'), disabled: true, connectionRefs: {} },
            disabledLoop,
          ],
        },
        catalog,
      ),
    ).toEqual([]);
  });

  it('does not let projection metadata change compatibility identity', () => {
    const withoutMetadata = {
      definitions: [{ key: 'core.set', version: 1 }],
    };
    const graph = { ...EMPTY_WORKFLOW_GRAPH, nodes: [node('usage')] };
    expect(workflowCompatibilityReport(graph, catalog).fingerprint).toBe(
      workflowCompatibilityReport(graph, withoutMetadata).fingerprint,
    );
  });
});
describe('workflow draft representation tag', () => {
  it('has a stable opaque golden value and includes compatibility identity', () => {
    const graph = fixture();
    const fingerprint = workflowCompatibilityReport(
      graph,
      TEST_DEFINITION_CATALOG,
    ).fingerprint;
    const input = {
      workflowId: '11111111-1111-4111-8111-111111111111',
      revision: 7,
      graph,
      compatibilityFingerprint: fingerprint,
    } as const;
    expect(workflowDraftRepresentationTag(input)).toBe(
      '"draft.kXWuFnYb2U3wZ8REJuajiu5znEpT229xvo1daf6a7Nc"',
    );
    expect(
      workflowDraftRepresentationTag({
        ...input,
        compatibilityFingerprint: `${fingerprint}:changed`,
      }),
    ).not.toBe(workflowDraftRepresentationTag(input));
    expect(workflowDraftRepresentationTag({ ...input, revision: 8 })).not.toBe(
      workflowDraftRepresentationTag(input),
    );
  });
});
