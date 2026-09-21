import {
  workflowRunListQuerySchema,
  type WorkflowRunListQuery,
} from '@pertexo/contracts/schemas/workflow-runs';

export type RunHistoryFilters = Readonly<
  Pick<
    WorkflowRunListQuery,
    | 'workflowId'
    | 'workflowNamePrefix'
    | 'status'
    | 'createdAtFrom'
    | 'createdAtBefore'
  >
>;

const filterNames = new Set([
  'workflowId',
  'workflowNamePrefix',
  'status',
  'createdAtFrom',
  'createdAtBefore',
]);

export const runHistorySearchSchema = Object.freeze({
  parse(value: unknown): RunHistoryFilters {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new TypeError('run history search is invalid');
    const record = value as Readonly<Record<string, unknown>>;
    if (Object.keys(record).some((name) => !filterNames.has(name)))
      throw new TypeError('run history search is invalid');
    const parsed = workflowRunListQuerySchema.parse(record);
    return {
      ...(parsed.workflowId === undefined
        ? {}
        : { workflowId: parsed.workflowId }),
      ...(parsed.workflowNamePrefix === undefined
        ? {}
        : { workflowNamePrefix: parsed.workflowNamePrefix }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.createdAtFrom === undefined
        ? {}
        : { createdAtFrom: parsed.createdAtFrom }),
      ...(parsed.createdAtBefore === undefined
        ? {}
        : { createdAtBefore: parsed.createdAtBefore }),
    };
  },
});
