import { useWorkflowPublication } from '@/features/workflow-publish/data/mutations/use-workflow-publication';

import { emptyDraftHint } from '@/features/workflow-publish/model/publication/readiness';

import { groupWorkflowIssues } from '@/features/workflow-publish/model/validation/issues';

import type { ApiClient, ApiJsonRequest } from '@/lib/api/client';

import { act, renderHook } from '@testing-library/react';

import { describe, expect, it, vi } from 'vitest';

import { compatibility, graph, node } from './fixture';
import { QueryWrapper } from './query-wrapper';

describe('workflow issues', () => {
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
        currentPublication: null,
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
    expect(
      emptyDraftHint({ graph: graph([]), triggersAvailable: true })?.label,
    ).toBe('Add a trigger to start');
    expect(
      emptyDraftHint({ graph: graph([]), triggersAvailable: false }),
    ).toMatchObject({
      label: 'Add a step to start',
      detail: expect.stringMatching(/No triggers are enabled/u) as unknown,
    });
    expect(
      emptyDraftHint({
        graph: graph([node('a', 'core.set')]),
        triggersAvailable: true,
      }),
    ).toBe(undefined);
  });
});

describe('publication', () => {
  it('checks the saved draft itself before publishing and stops when it has issues', async () => {
    const paths: string[] = [];
    let valid = false;
    let saved = {
      etag: `"draft.${'a'.repeat(43)}"`,
      generation: 1,
      revision: 2,
    };
    const apiClient =
      /* This endpoint dispatcher supplies specific decoded responses; the generic ApiClient request signature cannot express its finite fixture responses. */ {
        request: (request: ApiJsonRequest<unknown>) => {
          paths.push(request.path.split('/').at(-1) ?? '');
          if (request.path.endsWith('/validate'))
            return Promise.resolve({
              report: { valid, issues: [], compatibility },
              etag: saved.etag,
            });
          return Promise.resolve({
            version: {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              versionNumber: 3,
              graph: graph([]),
              checksum: `wf:sha256:${'c'.repeat(64)}`,
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
          isSavedDraftCurrent: (checked) =>
            checked.generation === saved.generation &&
            checked.revision === saved.revision &&
            checked.etag === saved.etag,
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
