// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  firstThreadSteps,
  isNewWorkspace,
} from '@/features/overview/model/first-thread';
import { homeGreeting } from '@/features/overview/model/home-greeting';

// How Home welcomes a person: the greeting and the first thread to weave.

describe('greeting', () => {
  it('greets by first name and part of the day', () => {
    expect(homeGreeting('Dena Okafor', 9)).toBe('Good morning, Dena.');
    expect(homeGreeting(' Dena ', 14)).toBe('Good afternoon, Dena.');
    expect(homeGreeting(null, 20)).toBe('Good evening.');
    expect(homeGreeting('  ', 11)).toBe('Good morning.');
  });
});

describe('first thread', () => {
  it('derives steps from real reads and hides what the role cannot check', () => {
    const steps = firstThreadSteps({ workflows: [], hasRun: false });
    expect(steps.map((step) => [step.key, step.done])).toEqual([
      ['create', false],
      ['publish', false],
      ['run', false],
    ]);
    expect(
      firstThreadSteps({ connectionCount: 1, memberCount: 1 }).map((step) => [
        step.key,
        step.done,
      ]),
    ).toEqual([
      ['connection', true],
      ['invite', false],
    ]);
    expect(steps.map((step) => step.destination)).toEqual([
      { to: 'workflows', create: true },
      { to: 'workflows' },
      { to: 'workflows' },
    ]);
    expect(
      firstThreadSteps({
        destinationCount: 0,
        connectionCount: 0,
        memberCount: 1,
      }).map((step) => step.destination),
    ).toEqual([
      { to: 'connections', add: 'any' },
      { to: 'alerts' },
      { to: 'team', invite: true },
    ]);
    expect(isNewWorkspace({ hasRun: false })).toBe(true);
    expect(isNewWorkspace({ hasRun: true, workflows: [] })).toBe(false);
    expect(isNewWorkspace({ workflows: [] })).toBe(true);
    expect(isNewWorkspace({})).toBe(false);
  });
});
