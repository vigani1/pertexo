import { FIND_ROWS_V2 } from '@pertexo/node-sdk';
import { expect, it } from 'vitest';
import { agentConfigV3Schema, AGENT_TOOL_LIMITS } from '../../../src/index.js';

const tool = {
  definition: FIND_ROWS_V2,
  description: 'Look up orders',
  config: { table: 'Orders' },
};

it('rejects a repeated alias for an Agent tool', () => {
  const lookup = { ...tool, alias: 'lookup' };
  expect(
    agentConfigV3Schema.safeParse({ model: 'orders', tools: [lookup, lookup] })
      .success,
  ).toBe(false);
});

it('requires a tool list within the configured bound', () => {
  const tools = Array.from({ length: AGENT_TOOL_LIMITS.tools }, (_, index) => ({
    ...tool,
    alias: `lookup_${String(index)}`,
  }));
  expect(
    agentConfigV3Schema.safeParse({ model: 'orders', tools }).success,
  ).toBe(true);
  expect(
    agentConfigV3Schema.safeParse({ model: 'orders', tools: [] }).success,
  ).toBe(false);
  expect(
    agentConfigV3Schema.safeParse({
      model: 'orders',
      tools: [...tools, { ...tool, alias: 'extra' }],
    }).success,
  ).toBe(false);
});
