import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/policy';
import type { WorkflowTestSuiteStartRequest } from '@pertexo/contracts';
import {
  canonicalJson,
  snapshotBoundedJson,
  WORKFLOW_INPUT_CASE_LIMITS,
  WORKFLOW_TEST_SUITE_MAX_CASES,
  workflowTestExpectationsSchema,
} from '@pertexo/workflow-model';
import { requireTable } from '../../../data-tables/require-table.js';
import { findRows } from '../../../data-tables/rows/find-rows.js';
import { requireTestCapability } from '../../workflows/access.js';
import { WorkflowTestError } from '../../workflows/workflow-test.errors.js';

export async function snapshotTableCases(
  client: PoolClient,
  role: Role,
  workspaceId: string,
  evaluation: Extract<
    WorkflowTestSuiteStartRequest,
    { evaluation: unknown }
  >['evaluation'],
) {
  requireTestCapability(role, 'workspace:read');
  const table = await requireTable(
    client,
    workspaceId,
    { id: evaluation.tableId },
    { lock: true },
  );
  const names = new Map(table.columns.map(({ id, name }) => [id, name]));
  const columnName = (id: string) => {
    const name = names.get(id);
    if (name === undefined)
      throw new WorkflowTestError('evaluation_column_missing');
    return name;
  };
  const fields = Object.entries(evaluation.columns).map(
    ([field, id]) => [field, columnName(id)] as const,
  );
  const expected = evaluation.expectedColumns?.map((id) =>
    id === null ? null : columnName(id),
  );
  const page = await findRows(client, workspaceId, table, {
    filters: [],
    limit: WORKFLOW_TEST_SUITE_MAX_CASES,
    offset: 0,
  });
  if (page.hasMore) throw new WorkflowTestError('evaluation_case_limit');
  if (page.rows.length === 0) throw new WorkflowTestError('evaluation_empty');
  return page.rows.map((row) => {
    const expectations =
      expected === undefined
        ? evaluation.expectations
        : {
            ...evaluation.expectations,
            assertions: evaluation.expectations.assertions.map(
              (assertion, index) => {
                const column = expected[index];
                return column === null || column === undefined
                  ? assertion
                  : {
                      ...assertion,
                      expected: row.values[column] ?? null,
                    };
              },
            ),
          };
    if (
      expected !== undefined &&
      !workflowTestExpectationsSchema.safeParse(expectations).success
    )
      throw new WorkflowTestError('evaluation_expectation_invalid');
    const input = Object.fromEntries(
      fields.map(([field, name]) => [field, row.values[name] ?? null]),
    );
    const admitted = snapshotBoundedJson(
      input,
      {
        bytes: WORKFLOW_INPUT_CASE_LIMITS.payloadBytes,
        depth: WORKFLOW_INPUT_CASE_LIMITS.payloadDepth,
        members: WORKFLOW_INPUT_CASE_LIMITS.payloadMembers,
      },
      { jsonbText: true },
    );
    if (!admitted.ok) throw new WorkflowTestError('evaluation_input_invalid');
    return {
      id: row.id,
      revision: row.revision,
      name: row.id,
      input: canonicalJson(admitted.snapshot),
      expectations: canonicalJson(expectations),
    };
  });
}
