import { describe, expect, it } from 'vitest';
import { createRegistryRelease } from '@pertexo/node-sdk';
import { createNodeRegistry } from '@pertexo/node-sdk/server';

import {
  CORE_BOUNDED_JSON_POLICY,
  CORE_CONDITION_DEFINITION,
  CORE_CONDITION_EXECUTOR,
  CORE_FOR_EACH_DEFINITION,
  CORE_FOR_EACH_EXECUTOR,
  CORE_JSONATA_POLICY,
  CORE_MERGE_DEFINITION,
  CORE_MERGE_DEFINITION_V2,
  CORE_MERGE_EXECUTOR,
  CORE_MERGE_EXECUTOR_V2,
  CORE_NODE_DEFINITION_REGISTRATIONS,
  CORE_PARALLEL_DEFINITION,
  CORE_PARALLEL_DEFINITION_V2,
  CORE_PARALLEL_EXECUTOR,
  CORE_PARALLEL_EXECUTOR_V2,
  CORE_SCHEDULE_DEFINITION,
  CORE_SCHEDULE_DEFINITION_V2,
  CORE_SCHEDULE_EXECUTOR,
  CORE_SCHEDULE_EXECUTOR_V2,
  CORE_SWITCH_DEFINITION,
  CORE_SWITCH_EXECUTOR,
  CORE_WAIT_DEFINITION,
  CORE_WAIT_EXECUTOR,
  CORE_WEBHOOK_DEFINITION,
  CORE_WEBHOOK_EXECUTOR,
} from '../src/index.js';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from '../src/server.js';

const release = createRegistryRelease({
  epoch: 1,
  definitions: CORE_NODE_DEFINITION_REGISTRATIONS.map(
    ({ manifest }) => manifest,
  ),
  executors: CORE_NODE_EXECUTOR_REGISTRATIONS.map((registration) => ({
    abiVersion: registration.abiVersion,
    definitions: registration.definitions,
    executor: registration.executor,
    lifecycle: registration.lifecycle,
    policyReferences: registration.policyReferences,
  })),
  policies: [CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY],
});

const registry = createNodeRegistry({
  release,
  definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
  executors: CORE_NODE_EXECUTOR_REGISTRATIONS,
});
const signal = new AbortController().signal;

describe('core node public execution contracts', () => {
  it.each([
    {
      name: 'Condition true selection',
      definition: CORE_CONDITION_DEFINITION,
      executor: CORE_CONDITION_EXECUTOR,
      config: {},
      input: { condition: true },
      expected: { selectedPort: 'true' },
    },
    {
      name: 'Switch first match',
      definition: CORE_SWITCH_DEFINITION,
      executor: CORE_SWITCH_EXECUTOR,
      config: {
        cases: [
          { id: 'case-02', equals: 'match' },
          { id: 'case-01', equals: 'match' },
        ],
      },
      input: { value: 'match' },
      expected: { selectedPort: 'case-02' },
    },
    {
      name: 'Switch default',
      definition: CORE_SWITCH_DEFINITION,
      executor: CORE_SWITCH_EXECUTOR,
      config: { cases: [{ id: 'case-01', equals: 'other' }] },
      input: { value: 'unmatched' },
      expected: { selectedPort: 'default' },
    },
    {
      name: 'Parallel version 1',
      definition: CORE_PARALLEL_DEFINITION,
      executor: CORE_PARALLEL_EXECUTOR,
      config: {
        branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
        maxConcurrency: 2,
      },
      input: {},
      expected: { branchIds: ['branch-02', 'branch-01'] },
    },
    {
      name: 'Parallel version 2',
      definition: CORE_PARALLEL_DEFINITION_V2,
      executor: CORE_PARALLEL_EXECUTOR_V2,
      config: {
        branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
        maxConcurrency: 2,
      },
      input: {},
      expected: { branchIds: ['branch-02', 'branch-01'] },
    },
    {
      name: 'Merge version 1',
      definition: CORE_MERGE_DEFINITION,
      executor: CORE_MERGE_EXECUTOR,
      config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
      input: { ledger: {}, selectedBranchIds: [] },
      expected: { ledger: {}, selectedBranchIds: [] },
    },
    {
      name: 'Merge version 2',
      definition: CORE_MERGE_DEFINITION_V2,
      executor: CORE_MERGE_EXECUTOR_V2,
      config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
      input: {
        ledger: { 'branch-01': { disposition: 'arrived', output: true } },
        selectedBranchIds: ['branch-01'],
      },
      expected: {
        ledger: { 'branch-01': { disposition: 'arrived', output: true } },
        selectedBranchIds: ['branch-01'],
      },
    },
    {
      name: 'For Each',
      definition: CORE_FOR_EACH_DEFINITION,
      executor: CORE_FOR_EACH_EXECUTOR,
      config: {},
      input: { items: ['first', 2, null] },
      expected: { items: ['first', 2, null], iterationCount: 3 },
    },
    {
      name: 'Wait',
      definition: CORE_WAIT_DEFINITION,
      executor: CORE_WAIT_EXECUTOR,
      config: { durationSeconds: 5 },
      input: { value: 'resume' },
      expected: { value: 'resume' },
    },
    {
      name: 'Webhook',
      definition: CORE_WEBHOOK_DEFINITION,
      executor: CORE_WEBHOOK_EXECUTOR,
      config: {},
      input: { event: 'accepted' },
      expected: { event: 'accepted' },
    },
    {
      name: 'Schedule version 1',
      definition: CORE_SCHEDULE_DEFINITION,
      executor: CORE_SCHEDULE_EXECUTOR,
      config: { kind: 'interval', intervalMinutes: 5 },
      input: { scheduledAt: 'retained' },
      expected: { scheduledAt: 'retained' },
    },
    {
      name: 'Schedule version 2',
      definition: CORE_SCHEDULE_DEFINITION_V2,
      executor: CORE_SCHEDULE_EXECUTOR_V2,
      config: { kind: 'interval', intervalMinutes: 5 },
      input: {
        nodeId: 'schedule',
        scheduledAt: '2026-09-05T01:00:00.000Z',
        schemaVersion: 1,
        triggerId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01',
      },
      expected: {
        nodeId: 'schedule',
        scheduledAt: '2026-09-05T01:00:00.000Z',
        schemaVersion: 1,
        triggerId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01',
      },
    },
  ])('executes $name through the SDK registry boundary', async (fixture) => {
    await expect(
      registry.execute({
        config: fixture.config,
        definition: fixture.definition,
        executor: fixture.executor,
        input: fixture.input,
        signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: fixture.expected });
  });
});
