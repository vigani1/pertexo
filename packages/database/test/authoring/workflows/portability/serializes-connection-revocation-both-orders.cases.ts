import { expect, it } from 'vitest';
import {
  parseWorkflowGraphDraft,
  projectWorkflowPortableManifest,
  type WorkflowPortabilityCatalog,
} from '@pertexo/workflow-model';

import { WorkflowPortabilityValidationError } from '../../../../src/authoring/workflows/errors.js';

import {
  actorId,
  workspaceId,
  apiUrl,
  enforceTestRetention,
  migrationUrl,
  parseDatabaseConfig,
  emptyGraph,
  draftNode,
  holdAtWrite,
  importWrite,
  randomUUID,
  queryAsOwner,
  identity,
  WorkflowNotFoundError,
  Pool,
  createConnectionDatabase,
  CONNECTION_AUTH_TYPE,
  createHash,
  waitForOperationEntry,
  waitForPostgresLock,
  withApplicationName,
  finishControlledScenario,
  finishTransactionClient,
  purgeTestWorkspace,
} from '../../../support/workflow-authoring.js';
import { portableCatalog, database, command } from './fixture.js';

export function registerSerializesConnectionRevocationBothOrders(): void {
  it('serializes connection revocation in both orders and permits accepted replay after health loss', async () => {
    const connectionApplication = `portable-connection-${randomUUID()}`;
    const connections = createConnectionDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, connectionApplication),
        max: 2,
      }),
    );
    const providerCatalog: WorkflowPortabilityCatalog = {
      ...portableCatalog,
      definitions: [
        {
          key: 'test.placeholder',
          version: 1,
          configVersion: 1,
          slots: [
            { slot: 'account', providerKey: 'http', authType: 'http_headers' },
          ],
          validateConfig: () => true,
        },
      ],
    };
    const makeConnection = async () => {
      const id = randomUUID();
      await connections.createConnection({
        workspaceId,
        actorId,
        connectionId: id,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: `Portable race ${id}`,
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        idempotencyKey: randomUUID(),
        requestHash: createHash('sha256').update(id).digest('hex'),
        sealed: {
          kmsKeyReference: 'arn:aws:kms:region:account:key/portability-race',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('connection-race-secret').toString(
            'base64url',
          ),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
      });
      return id;
    };
    const winner = database({ portableCatalog: providerCatalog });
    const hold = await holdAtWrite(importWrite('workflow', command().name));
    let accepted: Promise<{ workflowId: string }> | undefined,
      revoked: Promise<unknown> | undefined,
      primaryError: unknown;
    try {
      const firstConnection = await makeConnection();
      const manifest = projectWorkflowPortableManifest(
        parseWorkflowGraphDraft({
          ...emptyGraph,
          nodes: [draftNode('provider')],
        }),
        providerCatalog,
      );
      const first = command({
        manifest,
        bindings: [
          {
            nodeId: 'provider',
            slot: 'account',
            connectionId: firstConnection,
          },
        ],
      });
      accepted = winner.importWorkflow(first);
      await waitForOperationEntry(
        hold.reached(),
        accepted,
        'portable connection admission',
      );
      revoked = connections.revokeConnection({
        workspaceId,
        actorId,
        connectionId: firstConnection,
      });
      await waitForPostgresLock(connectionApplication);
      await hold.release();
      const result = await accepted;
      await revoked;
      expect(await winner.importWorkflow(first)).toEqual(result);
      const secondConnection = await makeConnection();
      const secondApplication = `portable-binding-first-${randomUUID()}`;
      const loser = database(
        { portableCatalog: providerCatalog },
        withApplicationName(apiUrl, secondApplication),
      );
      const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
      const owner = await ownerPool.connect();
      let pending: Promise<unknown> | undefined, ownerError: unknown;
      try {
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await owner.query('select app.lock_workspace_run_admission($1)', [
          workspaceId,
        ]);
        await owner.query(
          "update app.connections set status='revoked',health_revision=health_revision+1,last_health_transition_at=clock_timestamp(),last_health_transition_source='revoke' where workspace_id=$1 and id=$2",
          [workspaceId, secondConnection],
        );
        pending = loser.importWorkflow(
          command({
            manifest,
            bindings: [
              {
                nodeId: 'provider',
                slot: 'account',
                connectionId: secondConnection,
              },
            ],
          }),
        );
        const rejected = expect(pending).rejects.toBeInstanceOf(
          WorkflowPortabilityValidationError,
        );
        await waitForPostgresLock(secondApplication);
        await owner.query('commit');
        await rejected;
      } catch (error) {
        ownerError = error;
      } finally {
        await finishTransactionClient(owner, {
          label: 'portable connection writer',
          primaryError: ownerError,
          transactionOpen: true,
        });
        await Promise.allSettled(pending === undefined ? [] : [pending]);
        await ownerPool.end();
      }
    } catch (error) {
      primaryError = error;
    } finally {
      await finishControlledScenario({
        label: 'portable connection races',
        primaryError,
        operations: [accepted, revoked],
        release: () => void hold.release(),
        close: [() => connections.close(), () => hold.remove()],
      });
    }
  });

  it('reaps expired actor-only receipts and erases the import through bounded workspace purge', async () => {
    const db = database();
    const workspace = await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Portable hold/purge',
      slug: `portable-purge-${randomUUID()}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    const scoped = workspace.id;
    const input = command({ workspaceId: scoped });
    const accepted = await db.importWorkflow(input);
    await queryAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.import'",
      [scoped],
      scoped,
    );
    await enforceTestRetention();
    expect(
      await queryAsOwner(
        "select id from app.idempotency_records where workspace_id=$1 and operation='workflow.import'",
        [scoped],
        scoped,
      ),
    ).toEqual([]);
    const fresh = await db.importWorkflow(input);
    expect(fresh.workflowId).not.toBe(accepted.workflowId);
    await purgeTestWorkspace(scoped);
    expect(
      await queryAsOwner(
        `select (select count(*)::int from app.idempotency_records where workspace_id=$1) receipts,
      (select count(*)::int from app.workflows where workspace_id=$1) workflows,
      (select count(*)::int from app.workflow_drafts where workspace_id=$1) drafts`,
        [scoped],
        scoped,
      ),
    ).toEqual([{ receipts: 0, workflows: 0, drafts: 0 }]);
    await expect(db.importWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });
}
