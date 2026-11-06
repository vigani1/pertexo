import { IdempotencyConflictError } from '@pertexo/database/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  emptyGraph,
  otherWorkspaceId,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../support/workflow-authoring.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  promotions,
  published,
  scope,
} from './commands/fixture.js';

async function damage(operation: string) {
  const rows = await queryAsOwner(
    `update app.idempotency_records set result_ref='{"damaged":true}'::jsonb
     where workspace_id=$1 and operation=$2 returning id`,
    [workspaceId, operation],
    workspaceId,
  );
  expect(rows.length).toBeGreaterThan(0);
}

describe('a damaged promotion receipt is reported as stored-data corruption', () => {
  beforeAll(beforeAllFixture1);
  afterAll(afterAllFixture2);

  it('choosing a promotion target', async () => {
    const settings = await promotions().settings(scope());
    const idempotencyKey = randomUUID();
    const input = {
      ...scope(),
      expectedRevision: settings.revision,
      expectedTargetWorkspaceId: settings.target?.workspaceId ?? null,
      targetWorkspaceId: otherWorkspaceId,
      idempotencyKey,
    };
    await promotions().setTarget(input);
    await damage('workspace.promotion.target');
    await expect(promotions().setTarget(input)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('applying a promotion', async () => {
    const selection = await published(emptyGraph);
    const preview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    const idempotencyKey = randomUUID();
    const input = {
      ...scope(),
      selections: [selection],
      mode: 'draft' as const,
      fingerprint: preview.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey,
    };
    await promotions().apply(input);
    await damage('workflow.promote');
    await expect(promotions().apply(input)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });
});
