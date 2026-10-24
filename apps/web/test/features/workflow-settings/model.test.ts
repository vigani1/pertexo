import { describe, expect, it } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { describeDelivery } from '@/features/workflow-settings/model/triggers/delivery-outcome';
import { describeDestination } from '@/features/workflow-settings/model/destination-label';
import { extractEndpointKey } from '@/features/workflow-settings/model/triggers/endpoint-key';
import { describeTriggerState } from '@/features/workflow-settings/model/triggers/state';
import {
  diffWorkflowGraphs,
  isEmptyDiff,
} from '@/features/workflows/comparison.public';
import { versionSteps } from '@/features/workflow-settings/model/versions/steps';
import { emptyGraph, stepNode } from './fixtures';

describe('webhook endpoint keys', () => {
  const key = 'A1b2_C3-d4'.padEnd(43, 'x');

  it('takes the key from a pasted address or the bare key', () => {
    expect(extractEndpointKey(`  ${key} `)).toBe(key);
    expect(extractEndpointKey(`https://api.example.test/hooks/${key}`)).toBe(
      key,
    );
    expect(
      extractEndpointKey(`https://api.example.test/hooks/${key}?a=1`),
    ).toBe(key);
    expect(
      extractEndpointKey('https://api.example.test/hooks/short'),
    ).toBeUndefined();
    expect(extractEndpointKey(`${key}x`)).toBeUndefined();
  });
});

describe('trigger states', () => {
  it('turns status and health into one word', () => {
    expect(
      describeTriggerState({ status: 'active', healthStatus: 'healthy' }),
    ).toEqual({ tone: 'success', label: 'Healthy' });
    expect(
      describeTriggerState({ status: 'active', healthStatus: 'pending' }),
    ).toEqual({ tone: 'neutral', label: 'Ready' });
    expect(
      describeTriggerState({ status: 'pending', healthStatus: 'pending' })
        .label,
    ).toBe('Starting');
    expect(
      describeTriggerState({ status: 'disabled', healthStatus: 'disabled' }),
    ).toEqual({ tone: 'canceled', label: 'Off' });
    expect(
      describeTriggerState({ status: 'error', healthStatus: 'unhealthy' }).tone,
    ).toBe('failure');
  });
});

describe('version changes', () => {
  const graph = (nodes: unknown[], edges: unknown[] = []) =>
    ({ ...emptyGraph, nodes, edges }) as unknown as WorkflowGraphContract;
  const edge = (from: string, to: string) => ({
    id: `${from}-${to}`,
    source: { nodeId: from, port: 'out' },
    target: { nodeId: to, port: 'in' },
  });

  it('lists added, removed and changed steps, ignoring canvas moves', () => {
    const before = graph(
      [
        stepNode('hook', 'core.webhook'),
        stepNode('old', 'core.set', 'Tidy'),
        { ...stepNode('call', 'http.request', 'Call API'), config: { a: 1 } },
      ],
      [edge('hook', 'old')],
    );
    const after = graph(
      [
        { ...stepNode('hook', 'core.webhook'), position: { x: 400, y: 20 } },
        { ...stepNode('call', 'http.request', 'Call API'), config: { a: 2 } },
        stepNode('mail', 'email.send_notification'),
      ],
      [edge('hook', 'call')],
    );
    expect(diffWorkflowGraphs(before, after)).toEqual({
      lines: [
        { target: 'step', kind: 'added', id: 'mail', label: 'Send email' },
        { target: 'step', kind: 'removed', id: 'old', label: 'Tidy' },
        {
          target: 'step',
          kind: 'changed',
          id: 'call',
          label: 'Call API',
          detail: 'setup',
        },
        {
          target: 'links',
          kind: 'changed',
          id: 'links',
          label: 'Links between steps',
          detail: '1 added, 1 removed',
        },
      ],
      linksAdded: 1,
      linksRemoved: 1,
      layoutOnly: false,
      added: [{ id: 'mail', label: 'Send email' }],
      removed: [{ id: 'old', label: 'Tidy' }],
      changed: [{ id: 'call', label: 'Call API', detail: 'setup' }],
      notes: [],
      linksChanged: true,
      contractChanged: false,
      settingsChanged: false,
    });
    expect(isEmptyDiff(diffWorkflowGraphs(after, after))).toBe(true);
  });

  it('reads steps triggers first, then left to right', () => {
    const steps = versionSteps(
      graph([
        { ...stepNode('b', 'http.request'), position: { x: 300, y: 0 } },
        { ...stepNode('a', 'core.schedule'), position: { x: 500, y: 0 } },
        { ...stepNode('c', 'core.set', 'Shape'), position: { x: 100, y: 0 } },
      ]),
    );
    expect(steps.map((step) => [step.label, step.kind, step.trigger])).toEqual([
      ['Schedule', 'Schedule', true],
      ['Shape', 'Set fields', false],
      ['HTTP request', 'HTTP request', false],
    ]);
  });
});

describe('alert destinations', () => {
  it('names destinations in words, with the connection when known', () => {
    const names = new Map([['c1', 'Ops bot']]);
    expect(
      describeDestination(
        {
          config: {
            kind: 'slack',
            connectionId: 'c1',
            channelId: 'C0123',
          },
        },
        names,
      ),
    ).toBe('Slack channel C0123 via Ops bot');
    expect(
      describeDestination(
        {
          config: {
            kind: 'email',
            connectionId: 'c2',
            toEmail: 'ops@example.test',
          },
        },
        names,
      ),
    ).toBe('Email to ops@example.test');
  });
});

describe('webhook delivery outcomes', () => {
  it.each([
    {
      outcome: 'accepted',
      signatureCheck: 'verified',
      replayCheck: 'new',
      tone: 'success',
      label: 'Accepted',
    },
    {
      outcome: 'replayed',
      signatureCheck: 'verified',
      replayCheck: 'duplicate',
      tone: 'neutral',
      label: 'Duplicate',
    },
    {
      outcome: 'authentication_failed',
      signatureCheck: 'mismatch',
      replayCheck: 'not_checked',
      tone: 'failure',
      label: 'Authentication failed',
    },
    {
      outcome: 'authentication_failed',
      signatureCheck: 'not_checked',
      replayCheck: 'stale_timestamp',
      tone: 'failure',
      label: 'Too old',
    },
    {
      outcome: 'authentication_failed',
      signatureCheck: 'verified',
      replayCheck: 'new',
      tone: 'attention',
      label: 'Not accepting',
    },
    {
      outcome: 'invalid_request',
      signatureCheck: 'verified',
      replayCheck: 'not_checked',
      tone: 'failure',
      label: 'Invalid request',
    },
    {
      outcome: 'conflict',
      signatureCheck: 'verified',
      replayCheck: 'conflict',
      tone: 'attention',
      label: 'Key reused',
    },
    {
      outcome: 'rate_limited',
      signatureCheck: 'verified',
      replayCheck: 'new',
      tone: 'attention',
      label: 'Held back',
    },
    {
      outcome: 'paused',
      signatureCheck: 'verified',
      replayCheck: 'new',
      tone: 'attention',
      label: 'Paused',
    },
  ] as const)(
    'reads $outcome ($signatureCheck, $replayCheck) as a $tone “$label”',
    ({ outcome, signatureCheck, replayCheck, tone, label }) => {
      const described = describeDelivery({
        outcome,
        signatureCheck,
        replayCheck,
      });
      expect(described).toMatchObject({ tone, label });
      expect(described.detail).not.toMatch(/_/u);
    },
  );
});

it.each(['accepted', 'replayed', 'coordinated'] as const)(
  'shows current coordinated status for an originally %s delivery',
  (outcome) => {
    const event = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      nodeId: 'webhook',
      source: 'webhook' as const,
      mode: 'debounce' as const,
      outcome: 'debounced' as const,
      status: 'started' as const,
      reason: null,
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      versionNumber: 1,
      receivedAt: '2026-10-17T00:00:00Z',
      dueAt: null,
      finishedAt: '2026-10-17T00:00:02Z',
    };
    expect(
      describeDelivery({
        outcome,
        signatureCheck: 'verified',
        replayCheck: 'new',
        coordination: event,
      }),
    ).toMatchObject({ tone: 'success', label: 'Started' });
    expect(
      describeDelivery({
        outcome,
        signatureCheck: 'verified',
        replayCheck: 'new',
        coordination: {
          ...event,
          status: 'coalesced',
          reason: 'newer_event',
          runId: null,
        },
      }),
    ).toMatchObject({ tone: 'skipped', label: 'Replaced by a newer event' });
  },
);

it('keeps a transport retry distinct from a second coordinated run', () => {
  const coordination = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    nodeId: 'webhook',
    source: 'webhook' as const,
    mode: 'debounce' as const,
    outcome: 'debounced' as const,
    status: 'started' as const,
    reason: null,
    runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    versionNumber: 1,
    receivedAt: '2026-10-17T00:00:00Z',
    dueAt: null,
    finishedAt: '2026-10-17T00:00:02Z',
  };
  const described = describeDelivery({
    outcome: 'replayed',
    signatureCheck: 'verified',
    replayCheck: 'duplicate',
    coordination,
  });
  expect(described).toMatchObject({
    tone: 'neutral',
    label: 'Duplicate · Started',
  });
  expect(described.detail).toContain('No additional run.');
});
