import { describe, expect, it } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { describeDelivery } from '@/features/workflow-settings/model/delivery-outcome';
import { describeDestination } from '@/features/workflow-settings/model/destination-label';
import { extractEndpointKey } from '@/features/workflow-settings/model/endpoint-key';
import { describeTriggerState } from '@/features/workflow-settings/model/trigger-state';
import {
  diffWorkflowGraphs,
  isEmptyDiff,
} from '@/features/workflow-settings/model/version-diff';
import { versionSteps } from '@/features/workflow-settings/model/version-steps';
import { emptyGraph, stepNode } from './workflow-settings.fixtures';

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
      added: ['Send email'],
      removed: ['Tidy'],
      changed: ['Call API'],
      connectionsChanged: true,
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
      ['Shape', 'Set values', false],
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
    ['accepted', 'verified', 'new', 'success', 'Accepted'],
    ['replayed', 'verified', 'duplicate', 'neutral', 'Duplicate'],
    [
      'authentication_failed',
      'mismatch',
      'not_checked',
      'failure',
      'Signature didn’t match',
    ],
    [
      'authentication_failed',
      'not_checked',
      'stale_timestamp',
      'failure',
      'Too old',
    ],
    ['authentication_failed', 'verified', 'new', 'attention', 'Not accepting'],
    [
      'invalid_request',
      'verified',
      'not_checked',
      'failure',
      'Invalid request',
    ],
    ['conflict', 'verified', 'conflict', 'attention', 'Key reused'],
    ['rate_limited', 'verified', 'new', 'attention', 'Held back'],
  ] as const)(
    'reads %s (%s, %s) as a %s “%s”',
    (outcome, signatureCheck, replayCheck, tone, label) => {
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
