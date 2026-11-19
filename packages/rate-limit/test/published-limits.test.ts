import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  AbuseRateLimitPolicy,
  type RateLimitEndpointClass,
} from '../src/server.js';

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

describe('the limits the single sign-on guide publishes', () => {
  it('states the policy’s per-address budgets for identity-provider sign-ins', async () => {
    const guide = (
      await readFile(
        new URL('../../../docs/guides/single-sign-on.md', import.meta.url),
        'utf8',
      )
    ).replace(/\s+/gu, ' ');
    const perAddress = (endpoint: RateLimitEndpointClass) =>
      new AbuseRateLimitPolicy()
        .evaluate(endpoint, { clientAddress: '203.0.113.8' })
        .dimensions.find((dimension) => dimension.kind === 'client_address')
        ?.limit.toLocaleString('en-US');
    const signIns = perAddress('federated_sign_in_start');

    expect(perAddress('federated_sign_in_callback')).toBe(signIns);
    expect(guide).toContain(
      `limited to ${String(signIns)} a minute per address`,
    );
    expect(guide).toContain(
      `reads to ${String(perAddress('sign_in_page_read'))}`,
    );
  });
});
