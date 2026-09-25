import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { diffWorkflowGraphs } from '@/features/workflow-drafts/public';
import { emptyDraftHint } from '@/features/workflow-publish/model/publish-readiness';
import { summarizePublish } from '@/features/workflow-publish/model/publish-summary';
import {
  AUTO_VALIDATION_MIN_INTERVAL_MS,
  AUTO_VALIDATION_QUIET_MS,
  autoValidationDelay,
  needsAutoValidation,
} from '@/features/workflow-publish/model/validation-throttle';
import { groupWorkflowIssues } from '@/features/workflow-publish/model/workflow-issues';
import { useWorkflowPublication } from '@/features/workflow-publish/mutations/use-workflow-publication';
import type { ApiClient, ApiJsonRequest } from '@/lib/api/client';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

function node(
  id: string,
  key: string,
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    ...extra,
  };
}

function graph(
  nodes: readonly WorkflowNode[],
  edges: WorkflowGraphContract['edges'] = [],
): WorkflowGraphContract {
  return { schemaVersion: 1, nodes, edges, settings: {} };
}

const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
  issues: [],
};

describe('automatic validation throttle', () => {
  const base = {
    enabled: true,
    saveStatus: 'clean',
    inspectorScratch: false,
    pending: false,
    revision: 4,
    generation: 9,
    checked: undefined,
    attemptedRevision: undefined,
  } as const;

  it('checks a clean saved revision once, and nothing unsaved or half-typed', () => {
    expect(needsAutoValidation(base)).toBe(true);
    expect(needsAutoValidation({ ...base, saveStatus: 'dirty' })).toBe(false);
    expect(needsAutoValidation({ ...base, saveStatus: 'saving' })).toBe(false);
    expect(needsAutoValidation({ ...base, inspectorScratch: true })).toBe(
      false,
    );
    expect(needsAutoValidation({ ...base, pending: true })).toBe(false);
    expect(needsAutoValidation({ ...base, enabled: false })).toBe(false);
    expect(needsAutoValidation({ ...base, attemptedRevision: 4 })).toBe(false);
    expect(
      needsAutoValidation({ ...base, checked: { revision: 4, generation: 9 } }),
    ).toBe(false);
    expect(
      needsAutoValidation({ ...base, checked: { revision: 3, generation: 9 } }),
    ).toBe(true);
  });

  it('waits for editing to pause and never starts within five seconds', () => {
    const now = 100_000;
    expect(
      autoValidationDelay({
        now,
        lastStartedAt: undefined,
        blockedUntil: undefined,
      }),
    ).toBe(AUTO_VALIDATION_QUIET_MS);
    expect(
      autoValidationDelay({
        now,
        lastStartedAt: now - 1_000,
        blockedUntil: undefined,
      }),
    ).toBe(AUTO_VALIDATION_MIN_INTERVAL_MS - 1_000);
    expect(
      autoValidationDelay({
        now,
        lastStartedAt: now - 60_000,
        blockedUntil: undefined,
      }),
    ).toBe(AUTO_VALIDATION_QUIET_MS);
    expect(
      autoValidationDelay({
        now,
        lastStartedAt: undefined,
        blockedUntil: now + 24_000,
      }),
    ).toBe(24_000);
  });
});

describe('publish summary', () => {
  it('lists steps added, removed and changed against the live version', () => {
    const live = graph([
      node('trigger', 'core.webhook', { label: 'New invoice' }),
      node('old', 'slack.send_message'),
      node('check', 'core.validate', { position: { x: 0, y: 0 } }),
    ]);
    const draft = graph(
      [
        node('trigger', 'core.webhook', { label: 'New invoice' }),
        node('check', 'core.validate', {
          position: { x: 300, y: 0 },
          config: { rules: [] },
        }),
        node('post', 'http.request', { label: 'Post to ERP' }),
      ],
      [
        {
          id: 'e1',
          source: { nodeId: 'trigger', port: 'out' },
          target: { nodeId: 'check', port: 'in' },
        },
      ],
    );
    const summary = summarizePublish(draft, {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      versionNumber: 7,
      schemaVersion: 1,
      graph: live,
      checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
      publishedAt: '2026-09-14T10:02:00.000Z',
    });
    expect(summary.nextVersionNumber).toBe(8);
    expect(summary.previousVersionNumber).toBe(7);
    expect(summary.lines).toEqual([
      { kind: 'added', nodeId: 'post', name: 'Post to ERP' },
      { kind: 'removed', nodeId: 'old', name: 'Send Slack message' },
      { kind: 'changed', nodeId: 'check', name: 'Validate', detail: 'setup' },
    ]);
    expect(summary.connectionsAdded).toBe(1);
    expect(summary.triggerNames).toEqual(['New invoice']);
  });

  it('treats a first publish as version 1 and layout-only changes as no step change', () => {
    const first = summarizePublish(graph([node('a', 'core.manual')]), null);
    expect(first).toMatchObject({
      nextVersionNumber: 1,
      previousVersionNumber: null,
    });
    const moved = diffWorkflowGraphs(
      graph([node('a', 'core.set')]),
      graph([node('a', 'core.set', { position: { x: 10, y: 0 } })]),
    );
    expect(moved.changed[0]?.aspects).toEqual(['position']);
    expect(
      diffWorkflowGraphs(
        graph([node('a', 'core.set')]),
        graph([node('a', 'core.set', { position: { x: 10, y: 0 } })]),
        { ignoreLayout: true },
      ).changed,
    ).toEqual([]);
  });
});

describe('workflow issues', () => {
  it('groups findings by step in human words, with workflow-wide ones last', () => {
    const draft = graph([node('a', 'core.set'), node('b', 'core.retired')]);
    const groups = groupWorkflowIssues(
      {
        valid: false,
        issues: [
          { path: '$', code: 'cycle', message: 'cycle contains a' },
          {
            path: '$.nodes.a.inputMappings.customer',
            code: 'invalid_mapping',
            message:
              'node output mappings must reference a direct local predecessor',
          },
          {
            path: '$.nodes[0].config.url',
            code: 'invalid_config',
            message: 'url is required',
          },
        ],
        compatibility: {
          ...compatibility,
          compatible: false,
          issues: [
            {
              code: 'unknown_definition',
              definitionKey: 'core.retired',
              version: 1,
            },
          ],
        },
      },
      draft,
    );
    expect(groups.map((group) => group.nodeId)).toEqual(['a', 'b', null]);
    expect(groups[0]?.issues.map((issue) => issue.target)).toEqual([
      { nodeId: 'a', mappingKey: 'customer' },
      { nodeId: 'a', fieldKey: 'url' },
    ]);
    expect(groups[0]?.issues[1]?.message).toBe('Url is required.');
    expect(groups[2]?.issues[0]?.message).toMatch(/loop back on themselves/u);
  });

  it('files findings inside a For each body under the body step, or the For each', () => {
    const inner = node('check', 'core.set');
    const loop = node('loop', 'core.foreach', {
      structured: {
        kind: 'for_each',
        maxIterations: 10,
        maxConcurrency: 1,
        body: {
          ...graph([inner, node('retired', 'core.retired')]),
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
        },
      },
    });
    const body = '$.nodes.loop.structured.body';
    const groups = groupWorkflowIssues(
      {
        valid: false,
        issues: [
          {
            path: `${body}.nodes.check.inputMappings.item`,
            code: 'invalid_structured_body',
            message:
              'structured input must reference a port on the nearest body',
          },
          {
            path: body,
            code: 'invalid_structured_body',
            message: 'For Each body must not be empty',
          },
        ],
        compatibility: {
          ...compatibility,
          compatible: false,
          issues: [
            {
              code: 'unknown_definition',
              definitionKey: 'core.retired',
              version: 1,
            },
          ],
        },
      },
      graph([loop]),
    );
    expect(
      groups.map((group) => [
        group.nodeId,
        group.issues.map((issue) => issue.target),
      ]),
    ).toEqual([
      ['check', [{ nodeId: 'check', mappingKey: 'item' }]],
      ['loop', [{ nodeId: 'loop' }]],
      ['retired', [{ nodeId: 'retired' }]],
    ]);
  });
});

describe('publish readiness', () => {
  it('asks an empty draft for a first step, and leaves the rest to the server', () => {
    expect(emptyDraftHint(graph([]), true)?.label).toBe(
      'Add a trigger to start',
    );
    expect(emptyDraftHint(graph([]), false)).toMatchObject({
      label: 'Add a step to start',
      detail: expect.stringMatching(/No triggers are enabled/u) as unknown,
    });
    expect(emptyDraftHint(graph([node('a', 'core.set')]), true)).toBe(
      undefined,
    );
  });
});

describe('publication', () => {
  it('checks the saved draft itself before publishing and stops when it has issues', async () => {
    const paths: string[] = [];
    let valid = false;
    let saved = {
      etag: `"draft-v1.${'a'.repeat(43)}"`,
      generation: 1,
      revision: 2,
    };
    const apiClient = {
      request: (request: ApiJsonRequest<unknown>) => {
        paths.push(request.path.split('/').at(-1) ?? '');
        if (request.path.endsWith('/validate'))
          return Promise.resolve({ valid, issues: [], compatibility });
        return Promise.resolve({
          version: {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            versionNumber: 3,
            schemaVersion: 1,
            graph: graph([]),
            checksum: `wf:v1:sha256:${'c'.repeat(64)}`,
            publishedAt: '2026-09-15T10:00:00.000Z',
          },
          reused: false,
        });
      },
      stream: vi.fn(),
    } as unknown as ApiClient;
    const hook = renderHook(
      () =>
        useWorkflowPublication({
          apiClient,
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          verifyIdentity: () => Promise.resolve(),
          ensureSaved: () => Promise.resolve(saved),
        }),
      { wrapper: QueryWrapper },
    );

    let result = await act(() => hook.result.current.publish());
    expect(result).toEqual({ kind: 'blocked' });
    expect(paths).toEqual(['validate']);

    result = await act(() => hook.result.current.publish());
    expect(result).toEqual({ kind: 'blocked' });
    expect(paths).toEqual(['validate']);

    valid = true;
    saved = { ...saved, generation: 2, revision: 3 };
    result = await act(() => hook.result.current.publish());
    expect(paths).toEqual(['validate', 'validate', 'publish']);
    expect(result).toMatchObject({
      kind: 'published',
      receipt: { versionNumber: 3, revision: 3 },
    });
  });
});

function QueryWrapper({ children }: Readonly<{ children: ReactNode }>) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    children,
  );
}
