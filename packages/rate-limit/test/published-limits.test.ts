import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  AbuseRateLimitPolicy,
  type RateLimitEndpointClass,
} from '../src/index.js';

const ROWS: readonly (readonly [string, RateLimitEndpointClass])[] = [
  ['Reads', 'authenticated_read'],
  ['Starting a run', 'run_admission'],
  ['Publishing, import and export', 'workflow_compile'],
  ['Other changes', 'ordinary_mutation'],
];

describe('the limits the automation guide publishes', () => {
  it.each(ROWS)('states the policy’s budget for %s', async (row, endpoint) => {
    const guide = await readFile(
      new URL('../../../docs/guides/automation.md', import.meta.url),
      'utf8',
    );
    const { dimensions, windowSeconds } = new AbuseRateLimitPolicy().evaluate(
      endpoint,
      { actorId: 'actor', workspaceId: 'workspace' },
    );
    const budget = (kind: string) =>
      dimensions.find((dimension) => dimension.kind === kind)?.limit;

    expect(windowSeconds).toBe(60);
    expect(guide).toContain(
      `| ${row} | ${String(budget('actor'))} | ${String(budget('workspace'))} |`,
    );
  });
});
