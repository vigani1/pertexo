import { sql, type SQL } from 'drizzle-orm';
import { alias as tableAlias } from 'drizzle-orm/pg-core';
import { workflowRuns } from '../schema/runs/execution.js';
const TEST_TRIGGER_TYPE = 'test';
const TEST_DAYS = 7;
const DETAILS_DAYS = 30;
const SUMMARY_DAYS = 90;
export const TEST_RUN_RETENTION_MILLIS = TEST_DAYS * 24 * 60 * 60 * 1000;
export const RUN_DETAILS_RETENTION_SQL =
  sql`make_interval(days=>${DETAILS_DAYS})`.inlineParams();
export const RUN_SUMMARY_RETENTION_SQL =
  sql`make_interval(days=>${SUMMARY_DAYS})`.inlineParams();
const TEST_RETENTION_SQL =
  sql`make_interval(days=>${TEST_DAYS})`.inlineParams();
type RunAlias = 'run' | 'workflow_runs';
type Clock = 'statement_timestamp()' | 'clock_timestamp()';
type RetentionKind = 'details' | 'summary';
function column(
  alias: RunAlias | undefined,
  key: 'triggerType' | 'createdAt' | 'completedAt',
): SQL {
  if (alias === undefined)
    return sql`${sql.identifier(workflowRuns[key].name)}`;
  return sql`${tableAlias(workflowRuns, alias)[key]}`;
}
export function isTestRun(triggerType: string | undefined): boolean {
  return triggerType === TEST_TRIGGER_TYPE;
}
export function testRunSql(alias?: RunAlias): SQL {
  return sql`${column(alias, 'triggerType')}=${TEST_TRIGGER_TYPE}`.inlineParams();
}
export function ordinaryRunSql(alias?: RunAlias): SQL {
  return sql`${column(alias, 'triggerType')}<>${TEST_TRIGGER_TYPE}`.inlineParams();
}
export function retainedTestRunSql(
  alias?: RunAlias,
  clock: Clock = 'statement_timestamp()',
): SQL {
  const now =
    clock === 'statement_timestamp()'
      ? sql`statement_timestamp()`
      : sql`clock_timestamp()`;
  return sql`(${ordinaryRunSql(alias)} or ${column(alias, 'createdAt')}>${now}-${TEST_RETENTION_SQL})`;
}
export function runRetentionIntervalSql(
  alias?: RunAlias,
  kind: RetentionKind = 'details',
): SQL {
  const ordinary =
    kind === 'details' ? RUN_DETAILS_RETENTION_SQL : RUN_SUMMARY_RETENTION_SQL;
  return sql`case when ${testRunSql(alias)} then ${TEST_RETENTION_SQL} else ${ordinary} end`;
}
export function expiredRunSql(
  alias: RunAlias,
  kind: RetentionKind = 'details',
): SQL {
  const created = column(alias, 'createdAt'),
    completed = column(alias, 'completedAt');
  return sql`${completed} is not null and (case when ${testRunSql(alias)} then ${created} else ${completed} end)<=clock_timestamp()-${runRetentionIntervalSql(alias, kind)}`;
}
export function runInputRetentionSql(triggerType: string): SQL {
  return isTestRun(triggerType)
    ? TEST_RETENTION_SQL
    : RUN_DETAILS_RETENTION_SQL;
}
