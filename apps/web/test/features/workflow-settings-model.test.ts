import { describe, expect, it } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { describeDestination } from '@/features/workflow-settings/model/destination-label';
import { extractEndpointKey } from '@/features/workflow-settings/model/endpoint-key';
import {
  describeCron,
  describeInterval,
  describeMisfirePolicy,
  describeRecurrence,
} from '@/features/workflow-settings/model/schedule-sentence';
import { describeTriggerState } from '@/features/workflow-settings/model/trigger-state';
import {
  diffWorkflowGraphs,
  isEmptyDiff,
} from '@/features/workflow-settings/model/version-diff';
import { versionSteps } from '@/features/workflow-settings/model/version-steps';
import { emptyGraph, stepNode } from './workflow-settings.fixtures';

describe('schedule sentences', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['5 * * * *', 'Every hour at :05'],
    ['0 */2 * * *', 'Every 2 hours at :00'],
    ['0 9 * * *', 'Every day at 09:00'],
    ['0 9 * * 1-5', 'Every weekday at 09:00'],
    ['30 7 * * MON-FRI', 'Every weekday at 07:30'],
    ['0 9 * * 0,6', 'Every Saturday and Sunday at 09:00'],
    ['0 9 * * 1,4', 'Every Monday and Thursday at 09:00'],
    ['0 18 * * 7', 'Every Sunday at 18:00'],
    ['0 9,17 * * *', 'Every day at 09:00 and 17:00'],
    ['30 8 1 * *', 'On the 1st of every month at 08:30'],
    ['0 9 1,15 * *', 'On the 1st and 15th of every month at 09:00'],
    ['0 9 22 * *', 'On the 22nd of every month at 09:00'],
    ['0 0 1 jan *', 'On the 1st of January at 00:00'],
    ['0 9 * 6 1', 'Every Monday in June at 09:00'],
    ['*/10 * * * 1-5', 'Every 10 minutes, every weekday'],
  ])('reads %s as “%s”', (expression, sentence) => {
    expect(describeCron(expression)).toBe(sentence);
  });

  it('names the expression when it can’t say it plainly', () => {
    expect(describeCron('0 9-17 * * *')).toBe(
      'On a custom schedule (0 9-17 * * *)',
    );
    expect(describeCron('15 14 1 * 1')).toBe(
      'On a custom schedule (15 14 1 * 1)',
    );
    expect(describeCron('61 * * * *')).toBe(
      'On a custom schedule (61 * * * *)',
    );
    expect(describeCron('* * *')).toBe('On a custom schedule (* * *)');
  });

  it('reads intervals in the largest whole unit', () => {
    expect(describeInterval(1)).toBe('Every minute');
    expect(describeInterval(90)).toBe('Every 90 minutes');
    expect(describeInterval(60)).toBe('Every hour');
    expect(describeInterval(1_440)).toBe('Every 24 hours');
    expect(describeInterval(4_320)).toBe('Every 3 days');
    expect(describeInterval(10_080)).toBe('Every week');
    expect(
      describeRecurrence({
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'Europe/Berlin',
      }),
    ).toBe('Every weekday at 09:00');
  });

  it('explains what happens to a missed run', () => {
    expect(describeMisfirePolicy('catch_up_once')).toMatch(/runs once/u);
    expect(describeMisfirePolicy('skip')).toMatch(/skipped/u);
  });
});

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
