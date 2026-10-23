import { expect, it } from 'vitest';
import {
  Pool,
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  emptyGraph,
  holdAtWrite,
  migrationUrl,
  parseDatabaseConfig,
  publicationWrite,
  queryAsOwner,
  randomUUID,
  saveCurrentDraft,
  workspaceId,
  waitForPostgresLock,
  waitForOperationEntry,
  withApplicationName,
} from '../../../support/workflow-authoring.js';

export function registerHoldsActorAuthorityStableUntil(): void {
  it.each(['save', 'publish', 'lifecycle'] as const)(
    'holds actor authority stable until the %s command commits',
    async (command) => {
      const created = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: `create-authority-${command}-${randomUUID()}`,
        name: `Authority ${command}`,
        workspaceId,
      });
      let writeBarrier: Parameters<typeof holdAtWrite>[0];
      if (command === 'save') {
        writeBarrier = {
          table: 'workflow_drafts',
          operation: 'update',
          when: `NEW.workflow_id = '${created.workflowId}'`,
        };
      } else {
        if (command === 'publish') {
          writeBarrier = publicationWrite('version', created.workflowId);
        } else {
          writeBarrier = {
            table: 'workflows',
            operation: 'update',
            when: `NEW.id = '${created.workflowId}' and NEW.lifecycle_status is distinct from OLD.lifecycle_status`,
          };
        }
      }
      const hold = await holdAtWrite(writeBarrier);
      const authorityApplication = `wa-${command}-${randomUUID()}`;
      const controlled = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      );
      const authorityPool = new Pool({
        connectionString: withApplicationName(
          migrationUrl,
          authorityApplication,
        ),
        max: 1,
      });
      const authority = await authorityPool.connect();
      let operation: Promise<unknown> | undefined;
      let suspension: Promise<unknown> | undefined;
      let authorityOpen = false;
      let primaryError: unknown;
      let cleanupFailures: unknown[] = [];
      try {
        if (command === 'save') {
          operation = saveCurrentDraft(controlled, {
            actorId,
            expectedRevision: 1,
            graphJson: {
              ...emptyGraph,
              settings: { maxRunDurationMs: 5_000 },
            },
            workflowId: created.workflowId,
            workspaceId,
          });
        } else {
          if (command === 'publish') {
            operation = controlled.publishWorkflow({
              actorId,
              representationTag: await currentRepresentationTag(
                controlled,
                workspaceId,
                {
                  scopedWorkflowId: created.workflowId,
                  scopedActorId: actorId,
                },
              ),
              idempotencyKey: `publish-authority-${created.workflowId}`,
              requestHash: '9'.repeat(64),
              workflowId: created.workflowId,
              workspaceId,
            });
          } else {
            operation = controlled.transitionWorkflowLifecycle({
              actorId,
              command: 'archive',
              expectedLifecycleRevision: 1,
              idempotencyKey: `archive-authority-${created.workflowId}`,
              workflowId: created.workflowId,
              workspaceId,
            });
          }
        }
        await waitForOperationEntry(
          hold.reached(),
          operation,
          `${command} authority command`,
        );

        await authority.query('begin');
        authorityOpen = true;
        await authority.query('set local role pertexo_owner');
        await authority.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        suspension = authority.query(
          `update app.workspace_memberships set status='suspended'
            where workspace_id=$1 and user_id=$2`,
          [workspaceId, actorId],
        );
        void suspension.catch(() => undefined);
        await waitForPostgresLock(authorityApplication);
        await hold.release();
        await expect(operation).resolves.toBeDefined();
        await expect(suspension).resolves.toMatchObject({ rowCount: 1 });
        await authority.query('rollback');
        authorityOpen = false;

        let auditAction;
        if (command === 'save') {
          auditAction = 'workflow.draft_saved';
        } else {
          if (command === 'publish') {
            auditAction = 'workflow.published';
          } else {
            auditAction = 'workflow.archived';
          }
        }
        const facts = await queryAsOwner<{
          audits: string;
          lifecycle_revision: number;
          published_version_id: string | null;
          revision: number;
        }>(
          `select draft.revision, workflow.lifecycle_revision,
                  workflow.published_version_id,
                  (select count(*) from app.audit_events audit
                    where audit.target_id=workflow.id
                      and audit.action = $2)::text audits
             from app.workflows workflow
             join app.workflow_drafts draft on draft.workflow_id=workflow.id
            where workflow.id=$1`,
          [created.workflowId, auditAction],
          workspaceId,
        );
        expect(facts[0]).toMatchObject({
          audits: '1',
          lifecycle_revision: command === 'lifecycle' ? 2 : 1,
          revision: command === 'save' ? 2 : 1,
        });
        if (command === 'publish')
          expect(facts[0]?.published_version_id).toEqual(expect.any(String));
        else expect(facts[0]?.published_version_id).toBeNull();
      } catch (error: unknown) {
        primaryError = error;
      } finally {
        await hold.release();
        if (authorityOpen)
          await authority.query('rollback').catch(() => undefined);
        await Promise.allSettled(
          [operation, suspension].filter(
            (value): value is Promise<unknown> => value !== undefined,
          ),
        );
        authority.release();
        const cleanup = await Promise.allSettled([
          authorityPool.end(),
          controlled.close(),
          hold.remove(),
        ]);
        cleanupFailures = cleanup.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
      }
      if (primaryError !== undefined) {
        if (cleanupFailures.length > 0)
          throw new AggregateError(
            [primaryError, ...cleanupFailures],
            `${command} authority proof and cleanup failed`,
          );
        if (primaryError instanceof Error) throw primaryError;
        throw new Error(`${command} authority proof failed`, {
          cause: primaryError,
        });
      }
      if (cleanupFailures.length > 0)
        throw new AggregateError(
          cleanupFailures,
          `${command} authority proof cleanup failed`,
        );
    },
    15_000,
  );
}
