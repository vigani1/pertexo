import type { DraftProposalResult } from '@pertexo/contracts';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';

export function proposalMaskingCases({
  workflow,
  propose,
  draft,
  save,
  requests,
  manual,
  httpRequest,
  httpWorkflow,
  settingSentinel,
}: Readonly<{
  workflow: () => Promise<string>;
  propose: (
    path: string,
    script: { graph: unknown; text?: string }[],
    request?: string,
  ) => Promise<DraftProposalResult>;
  draft: (
    path: string,
  ) => Promise<{ payload: string; headers: { etag?: unknown } }>;
  save: (
    path: string,
    etag: unknown,
    graph: unknown,
  ) => Promise<{ statusCode: number; payload: string }>;
  requests: readonly string[];
  manual: WorkflowNode;
  httpRequest: WorkflowNode;
  httpWorkflow: WorkflowGraph;
  settingSentinel: string;
}>) {
  it('lets the model change an existing URL while preserving the saved header', async () => {
    const path = await workflow();
    const original = {
      ...httpRequest,
      config: {
        url: 'https://api.example.test/orders',
        headers: { 'X-Partner-Reference': settingSentinel },
      },
    };
    const seeded = { ...httpWorkflow, nodes: [manual, original] };
    const initial = await draft(path);
    expect((await save(path, initial.headers.etag, seeded)).statusCode).toBe(
      200,
    );
    const before = await draft(path);
    const replacementUrl = 'https://api.example.test/v2/orders';
    const changed = {
      ...original,
      config: {
        url: replacementUrl,
        headers: { kind: 'existing_setting' },
      },
    };
    const start = requests.length;
    const result = await propose(path, [
      { graph: { ...seeded, nodes: [manual, changed] } },
    ]);
    expect(result).toMatchObject({
      kind: 'inspected',
      draft: {
        graph: {
          ...seeded,
          nodes: [
            manual,
            {
              ...original,
              config: { ...original.config, url: replacementUrl },
            },
          ],
        },
      },
    });
    expect(requests.slice(start)).toHaveLength(1);
    expect(requests[start]).toContain(original.config.url);
    expect(requests[start]).toContain('headers');
    expect(requests[start]).toContain('existing_setting');
    expect(requests[start]).not.toContain(settingSentinel);
    expect((await draft(path)).payload).toBe(before.payload);
  });

  it('reports an attempted change and addition to masked fields without sending either value back', async () => {
    const path = await workflow();
    const original = {
      ...httpRequest,
      config: {
        url: 'https://api.example.test/orders',
        headers: { 'X-Partner-Reference': settingSentinel },
      },
    };
    const seeded = { ...httpWorkflow, nodes: [manual, original] };
    const initial = await draft(path);
    expect((await save(path, initial.headers.etag, seeded)).statusCode).toBe(
      200,
    );
    const before = await draft(path);
    const start = requests.length;
    const attempted = {
      ...seeded,
      nodes: [
        manual,
        {
          ...original,
          config: {
            ...original.config,
            headers: { 'X-Partner-Reference': 'new-token' },
          },
          inputMappings: {
            body: { kind: 'literal', value: 'private-body-value' },
          },
        },
      ],
    };
    const reply = { graph: attempted };
    const result = await propose(
      path,
      [reply, reply, reply],
      'Change the X-Partner-Reference header to new-token.',
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      issues: [
        {
          code: 'masked_value_changed',
          path: '$.nodes.request.config.headers',
        },
        {
          code: 'masked_value_added',
          path: '$.nodes.request.inputMappings.body',
        },
      ],
    });
    expect(requests.slice(start)).toHaveLength(3);
    expect(requests[start + 1]).toContain('masked_value_changed');
    expect(requests[start + 1]).toContain('masked_value_added');
    // What the user typed is theirs to send, so only saved values are checked.
    for (const value of [settingSentinel, 'private-body-value'])
      expect(requests.slice(start).join('\n')).not.toContain(value);
    for (const value of [settingSentinel, 'new-token', 'private-body-value'])
      expect(JSON.stringify(result)).not.toContain(value);
    const after = await draft(path);
    expect(after.payload).toBe(before.payload);
    expect(after.payload).not.toContain('new-token');
    expect(after.payload).toContain(settingSentinel);
  });

  it('tells the user to edit a protected setting when the model declines to change it', async () => {
    const path = await workflow();
    const seeded = {
      ...httpWorkflow,
      nodes: [
        manual,
        {
          ...httpRequest,
          config: {
            url: 'https://api.example.test/orders',
            headers: { 'X-Partner-Reference': settingSentinel },
          },
        },
      ],
    };
    const initial = await draft(path);
    expect((await save(path, initial.headers.etag, seeded)).statusCode).toBe(
      200,
    );
    const before = await draft(path);
    const start = requests.length;
    const result = await propose(
      path,
      [{ graph: null, text: JSON.stringify({ maskedSetting: true }) }],
      'Change the X-Partner-Reference header to new-token.',
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      issues: [{ code: 'protected_setting_requested', path: '$' }],
      rounds: 0,
    });
    expect(requests.slice(start)).toHaveLength(1);
    expect(requests[start]).not.toContain(settingSentinel);
    expect((await draft(path)).payload).toBe(before.payload);
  });
}
