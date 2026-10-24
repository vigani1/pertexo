import { z } from 'zod';
import {
  DEFAULT_TEST_EXPECTATIONS,
  type WorkflowTestExpectations,
} from '@pertexo/workflow-model';

import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { WorkflowInputCaseDatabase, CaseTransaction } from './contract.js';
import { metadataColumns, metadata, workflow } from './metadata.queries.js';

export function listInputCases(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['listCases']>[0],
): ReturnType<WorkflowInputCaseDatabase['listCases']> {
  return transact(input, {
    write: false,
    work: async (client) => {
      const limit = z.number().int().min(1).max(100).parse(input.limit);
      await workflow(client, input, { write: false });
      const result = await client.query<Record<string, unknown>>(
        `select ${metadataColumns} from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2 and deleted_at is null and ($3::timestamptz is null or (created_at,id)>($3,$4::uuid)) order by created_at,id limit $5`,
        [
          input.workspaceId,
          input.workflowId,
          input.cursor?.createdAt ?? null,
          input.cursor?.id ?? null,
          limit + 1,
        ],
      );
      const items = result.rows.slice(0, limit).map(metadata);
      const last = items.at(-1);
      return {
        items,
        ...(result.rows.length > limit && last
          ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
          : {}),
      };
    },
  });
}

export function getInputCase(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['getCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['getCase']> {
  return transact(input, {
    write: false,
    work: async (client) => {
      z.uuid().parse(input.caseId);
      await workflow(client, input, { write: false });
      const result = await client.query<
        Record<string, unknown> & { expectations: string | null }
      >(
        `select c.*,p.input,p.expectations from app.workflow_input_cases c join app.workflow_input_case_payloads p on p.workspace_id=c.workspace_id and p.case_id=c.id and p.revision=c.revision where c.workspace_id=$1 and c.workflow_id=$2 and c.id=$3 and c.deleted_at is null`,
        [input.workspaceId, input.workflowId, input.caseId],
      );
      if (!result.rows[0])
        throw new WorkflowNotFoundError('Run-input case is not visible');
      return {
        case: {
          ...metadata(result.rows[0]),
          expectations:
            result.rows[0].expectations === null
              ? DEFAULT_TEST_EXPECTATIONS
              : (JSON.parse(
                  result.rows[0].expectations,
                ) as WorkflowTestExpectations),
          input: JSON.parse(z.string().parse(result.rows[0].input)) as unknown,
        },
      };
    },
  });
}
