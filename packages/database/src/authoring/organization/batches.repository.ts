import type { AudienceReview } from '@pertexo/contracts';
import {
  ADMINISTRATIVE_ROLES,
  WORKFLOW_EDITOR_ROLES,
} from '@pertexo/workflow-model';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { runOrganizationCommand } from './commands.repository.js';
import { WorkflowOrganizationValidationError } from './errors.js';
import {
  checkOrganizationReplay,
  organizeWorkflow,
  type OrganizationChange,
} from './placement.repository.js';
import {
  createOrganizationSession,
  type OrganizationRequestScope,
} from './session.js';

export type WorkflowOrganizationBatchItem = Readonly<{
  workflowId: string;
  expectedOrganizationRevision: number;
  audienceReview?: AudienceReview | undefined;
}>;
type Selection = Readonly<{ items: readonly WorkflowOrganizationBatchItem[] }>;
export type WorkflowOrganizationBatchRequest = Selection &
  (
    | Readonly<{ operation: 'move'; folderId: string | null }>
    | Readonly<{ operation: 'replace_tags'; tagIds: readonly string[] }>
    | Readonly<{ operation: 'tag_cleanup'; tagId: string }>
  );
export type WorkflowOrganizationBatchInput = OrganizationRequestScope &
  Readonly<{
    idempotencyKey: string;
    request: WorkflowOrganizationBatchRequest;
  }>;
export type WorkflowOrganizationBatchItemResult = Readonly<{
  workflowId: string;
  organizationRevision: number;
  replayed: boolean;
  folderId?: string | null;
}>;
export interface WorkflowOrganizationBatchDatabase {
  /** Claims the batch's key for its whole request, before any item runs. */
  admitBatch(
    input: WorkflowOrganizationBatchInput,
  ): Promise<Readonly<{ admitted: true }>>;
  /** Applies the batch to one of its workflows, as its own command. */
  executeBatchItem(
    input: WorkflowOrganizationBatchInput & Readonly<{ workflowId: string }>,
  ): Promise<WorkflowOrganizationBatchItemResult>;
  close(): Promise<void>;
}

const ADMINISTRATORS = ADMINISTRATIVE_ROLES;
const EDITORS = WORKFLOW_EDITOR_ROLES;

const uuid = z.uuid().overwrite((value) => value.toLowerCase());
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const itemResult = z
  .object({
    workflowId: uuid,
    organizationRevision: revision,
    folderId: uuid.nullable().optional(),
  })
  .strict();

type BatchRequest = WorkflowOrganizationBatchRequest;

const rolesFor = (body: BatchRequest) =>
  body.operation === 'tag_cleanup' ? ADMINISTRATORS : EDITORS;

function changeOf(body: BatchRequest): OrganizationChange {
  switch (body.operation) {
    case 'move':
      return { kind: 'move', folderId: body.folderId };
    case 'replace_tags':
      return { kind: 'replace_tags', tagIds: body.tagIds };
    case 'tag_cleanup':
      return { kind: 'detach_tag', tagId: body.tagId };
  }
}

/** A batch moves, retags or untags up to 50 workflows. Each workflow is its
 * own short transaction, so one conflict does not undo the others. */
export function createWorkflowOrganizationBatchDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowOrganizationBatchDatabase {
  const session = createOrganizationSession(config, options.runtime);
  return Object.freeze({
    admitBatch: async (input: WorkflowOrganizationBatchInput) => {
      const body = input.request;
      return session.transact(input, async (client, scope) => {
        await lockWorkflowAuthoringAuthority(client, scope.workspaceId, {
          actorId: scope.actorId,
          roles: rolesFor(body),
        });
        const identity = {
          workspaceId: scope.workspaceId,
          operation: 'organization.batch',
          scope: `${scope.actorId}:${scope.workspaceId}`,
          idempotencyKey: input.idempotencyKey,
        };
        const stored = await claimCommand(client, {
          ...identity,
          request: body,
          resourceId: scope.workspaceId,
        });
        if (stored === null)
          await completeCommand(client, identity, { admitted: true });
        return Object.freeze({ admitted: true as const });
      });
    },

    executeBatchItem: async (
      input: WorkflowOrganizationBatchInput & Readonly<{ workflowId: string }>,
    ) => {
      const body = input.request;
      const workflowId = input.workflowId;
      const selected = body.items.find(
        (entry) => entry.workflowId === workflowId,
      );
      if (selected === undefined)
        throw new WorkflowOrganizationValidationError();
      const baseChange = changeOf(body);
      const change =
        baseChange.kind === 'move' && selected.audienceReview !== undefined
          ? { ...baseChange, audienceReview: selected.audienceReview }
          : baseChange;
      return session.transact(input, async (client, scope) => {
        const { result, replayed } = await runOrganizationCommand(
          client,
          scope,
          {
            operation: 'organization.batch.item',
            target: workflowId,
            idempotencyKey: input.idempotencyKey,
            request: {
              change,
              expectedOrganizationRevision:
                selected.expectedOrganizationRevision,
            },
            roles: rolesFor(body),
            replay: () =>
              checkOrganizationReplay(client, scope, {
                workflowId,
                kind: change.kind,
                destinationFolderId:
                  change.kind === 'move' ? change.folderId : undefined,
              }),
            apply: async () => {
              const organizationRevision = await organizeWorkflow(
                client,
                scope,
                {
                  workflowId,
                  change,
                  expectedOrganizationRevision:
                    selected.expectedOrganizationRevision,
                },
              );
              return {
                result: {
                  workflowId,
                  organizationRevision,
                  ...(change.kind === 'move'
                    ? { folderId: change.folderId }
                    : {}),
                },
                audit: {
                  action: `workflow.organization.${body.operation}`,
                  targetId: workflowId,
                  metadata: { organizationRevision },
                },
              };
            },
          },
        );
        const { folderId, ...parsed } = itemResult.parse(result);
        return Object.freeze({
          ...parsed,
          ...(folderId === undefined ? {} : { folderId }),
          replayed,
        });
      });
    },

    close: session.close,
  });
}
