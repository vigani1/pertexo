import { parseDatabaseConfig } from '@pertexo/database/platform';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRunArtifactRetentionCoordinator } from '../../src/lifecycle/artifacts/artifact-retention.store.js';
import { createPreviewRetentionCoordinator } from '../../src/lifecycle/previews/preview-retention.store.js';
import { createWorkspacePurgeCoordinator } from '../../src/lifecycle/purge/workspace-purge.store.js';
import { createRetentionStore } from '../../src/lifecycle/retention/retention.store.js';
import { createOperatorCommandStore } from '../../src/operator/operator-command.store.js';

const config = parseDatabaseConfig({
  connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
});
const artifacts = {
  delete: () => Promise.resolve(),
  head: () => Promise.resolve(null),
};
const objects = {
  purgeWorkspacePage: () =>
    Promise.resolve({ completed: true, deletedCount: 0 }),
};

type Timeouts = Readonly<{
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}>;
type Closable = Readonly<{ close: () => Promise<void> }>;

const flows: readonly Readonly<{
  name: string;
  create: (options: Timeouts) => Closable;
  maximum: Readonly<{ lock: number; statement: number }>;
}>[] = [
  {
    name: 'the operator',
    create: (options) => createOperatorCommandStore(config, options),
    maximum: { lock: 300_000, statement: 300_000 },
  },
  {
    name: 'retention',
    create: (options) => createRetentionStore(config, options),
    maximum: { lock: 300_000, statement: 300_000 },
  },
  {
    name: 'run artifact retention',
    create: (options) =>
      createRunArtifactRetentionCoordinator(config, artifacts, options),
    maximum: { lock: 300_000, statement: 300_000 },
  },
  {
    name: 'preview retention',
    create: (options) =>
      createPreviewRetentionCoordinator(config, artifacts, options),
    maximum: { lock: 300_000, statement: 300_000 },
  },
  {
    name: 'workspace purge',
    create: (options) =>
      createWorkspacePurgeCoordinator(config, objects, options),
    maximum: { lock: 60_000, statement: 120_000 },
  },
];

describe.each(flows)('$name timeout options', ({ create, maximum }) => {
  it('accepts the lock and statement waits at both ends of their bounds', async () => {
    for (const options of [
      { lockTimeoutMs: 100, statementTimeoutMs: 1_000 },
      { lockTimeoutMs: maximum.lock, statementTimeoutMs: maximum.statement },
      {},
    ])
      await expect(create(options).close()).resolves.toBeUndefined();
  });

  it.each([
    { lockTimeoutMs: 99 },
    { lockTimeoutMs: maximum.lock + 1 },
    { statementTimeoutMs: 999 },
    { statementTimeoutMs: maximum.statement + 1 },
  ])('refuses %o at construction', (options) => {
    expect(() => create(options)).toThrow(z.ZodError);
  });
});
