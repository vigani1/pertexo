import { diffWorkflowGraphs } from '@/features/workflow-drafts/public';

import { ReviewCandidate } from '@/features/workflow-publish/components/reviews/candidate';

import { summarizePublish } from '@/features/workflow-publish/model/publication/summary';

import { groupWorkflowIssues } from '@/features/workflow-publish/model/validation/issues';

import {
  AUTO_VALIDATION_MIN_INTERVAL_MS,
  AUTO_VALIDATION_QUIET_MS,
  autoValidationDelay,
  needsAutoValidation,
} from '@/features/workflow-publish/model/validation/throttle';

import { fireEvent, render, screen } from '@testing-library/react';

import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { base, compatibility, graph, node } from './model/fixture';

describe('automatic validation throttle', () => {
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
  it.each([
    [undefined, { maximumAttempts: 5, delayMillis: 2_000 }],
    [
      { maximumAttempts: 5, delayMillis: 2_000 },
      { maximumAttempts: 1, delayMillis: 2_000 },
    ],
    [{ maximumAttempts: 1, delayMillis: 2_000 }, undefined],
  ] as const)(
    'counts a retry-only edit as a setup change: %o to %o',
    (before, after) => {
      expect(
        diffWorkflowGraphs(
          graph([node('action', 'core.set', { retry: before })]),
          graph([node('action', 'core.set', { retry: after })]),
          { ignoreLayout: true },
        ).changed,
      ).toMatchObject([{ aspects: ['setup'] }]);
    },
  );
  it('shows the exact reviewed retry override alongside the step setup', () => {
    render(
      createElement(ReviewCandidate, {
        graph: graph([
          node('action', 'core.set', {
            retry: { maximumAttempts: 5, delayMillis: 2_000 },
          }),
        ]),
        liveGraph: graph([node('action', 'core.set')]),
      }),
    );
    expect(screen.getByText(/0 steps added, 1 changed/u)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Setup and mappings'));
    expect(
      screen.getByText(/"maximumAttempts": 5/u, { selector: 'pre' }),
    ).toBeVisible();
    expect(
      screen.getByText(/"delayMillis": 2000/u, { selector: 'pre' }),
    ).toBeVisible();
  });
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
      graph: live,
      checksum: `wf:sha256:${'b'.repeat(64)}`,
      publishedAt: '2026-09-14T10:02:00.000Z',
    });
    expect(summary.nextVersionNumber).toBe(8);
    expect(summary.previousVersionNumber).toBe(7);
    expect(summary.lines).toEqual([
      { kind: 'added', nodeId: 'step:post', name: 'Post to ERP' },
      { kind: 'removed', nodeId: 'step:old', name: 'Send Slack message' },
      {
        kind: 'changed',
        nodeId: 'step:check',
        name: 'Validate',
        detail: 'setup',
      },
      {
        kind: 'changed',
        nodeId: 'links:links',
        name: 'Links between steps',
        detail: '1 added, 0 removed',
      },
    ]);
    expect(summary.linksAdded).toBe(1);
    expect(summary.triggerNames).toEqual(['New invoice']);
  });
  it('names every trigger that starts runs on its own, but not a manual start', () => {
    const summary = summarizePublish(
      graph([
        node('by-hand', 'core.manual'),
        node('form', 'core.form', { label: 'Expense form' }),
        node('fallback', 'core.workflow_error', { label: 'On failure' }),
        node('nightly', 'core.schedule', { label: 'Nightly' }),
      ]),
      null,
    );
    expect(summary.triggerNames).toEqual([
      'Expense form',
      'On failure',
      'Nightly',
    ]);
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
  it('distinguishes credential changes from links added and removed', () => {
    const before = graph(
      [
        node('start', 'core.manual'),
        node('fetch', 'http.request', {
          connectionRefs: {
            http_headers: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        }),
        node('finish', 'core.set'),
      ],
      [
        {
          id: 'old',
          source: { nodeId: 'start', port: 'out' },
          target: { nodeId: 'fetch', port: 'in' },
        },
      ],
    );
    const after = graph(
      before.nodes.map((step) =>
        step.id === 'fetch'
          ? {
              ...step,
              connectionRefs: {
                http_headers: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              },
            }
          : step,
      ),
      [
        {
          id: 'new',
          source: { nodeId: 'fetch', port: 'out' },
          target: { nodeId: 'finish', port: 'in' },
        },
      ],
    );
    expect(diffWorkflowGraphs(before, after)).toMatchObject({
      changed: [
        {
          before: before.nodes[1],
          after: after.nodes[1],
          aspects: ['connections'],
        },
      ],
      linksAdded: 1,
      linksRemoved: 1,
    });
    const credentialOnly = diffWorkflowGraphs(before, {
      ...before,
      nodes: after.nodes,
    });
    expect(credentialOnly.changed[0]?.aspects).toEqual(['connections']);
    expect(credentialOnly.linksAdded).toBe(0);
    expect(credentialOnly.linksRemoved).toBe(0);
  });
});

describe('workflow issues', () => {
  it('groups findings by step in human words, with workflow-wide ones last', () => {
    const draft = graph([node('a', 'core.set'), node('b', 'core.retired')]);
    const groups = groupWorkflowIssues(
      {
        valid: false,
        currentPublication: null,
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
});
