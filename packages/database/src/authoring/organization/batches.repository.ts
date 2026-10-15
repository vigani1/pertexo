import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { runOrganizationCommand } from './command.js';
import { WorkflowOrganizationValidationError } from './errors.js';
import {
  checkOrganizationReplay,
  organizeWorkflow,
  type OrganizationChange,
} from './organize-workflow.js';
import {
  createOrganizationSession,
  type OrganizationRequestScope,
} from './session.js';

export type WorkflowOrganizationBatchItem = Readonly<{
  workflowId: string;
  expectedOrganizationRevision: number;
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

const ADMINISTRATORS = ['owner', 'admin'] as const;
const EDITORS = ['owner', 'admin', 'builder'] as const;

const uuid = z.uuid().overwrite((value) => value.toLowerCase());
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const item = z
  .object({ workflowId: uuid, expectedOrganizationRevision: revision })
  .strict();
const items = z
  .array(item)
  .min(1)
  .max(50)
  .refine(
    (value) =>
      new Set(value.map((entry) => entry.workflowId)).size === value.length,
  );
const tags = z
  .array(uuid)
  .max(16)
  .refine((value) => new Set(value).size === value.length)
  .overwrite((value) => [...value].sort());
const request = z.discriminatedUnion('operation', [
  z
    .object({ operation: z.literal('move'), folderId: uuid.nullable(), items })
    .strict(),
  z
    .object({ operation: z.literal('replace_tags'), tagIds: tags, items })
    .strict(),
  z
    .object({ operation: z.literal('tag_cleanup'), tagId: uuid, items })
    .strict(),
]);
const itemResult = z
  .object({
    workflowId: uuid,
    organizationRevision: revision,
    folderId: uuid.nullable().optional(),
  })
  .strict();

type BatchRequest = z.output<typeof request>;

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
      const body = request.parse(input.request);
      return session.transact(input, async (client, scope) => {
        await lockWorkflowAuthoringAuthority(
          client,
          scope.workspaceId,
          scope.actorId,
          rolesFor(body),
        );
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
      const body = request.parse(input.request);
      const workflowId = uuid.parse(input.workflowId);
      const selected = body.items.find(
        (entry) => entry.workflowId === workflowId,
      );
      if (selected === undefined)
        throw new WorkflowOrganizationValidationError();
      const change = changeOf(body);
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
              checkOrganizationReplay(client, scope, workflowId, change.kind),
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
