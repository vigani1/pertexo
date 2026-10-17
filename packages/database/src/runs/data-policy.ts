const TEST_TRIGGER_TYPE = 'test';
const TEST_DAYS = 7;
const DETAILS_DAYS = 30;
const SUMMARY_DAYS = 90;

export const TEST_RUN_RETENTION_MILLIS = TEST_DAYS * 24 * 60 * 60 * 1000;
export const RUN_DETAILS_RETENTION_SQL = `interval '${String(DETAILS_DAYS)} days'`;
export const RUN_SUMMARY_RETENTION_SQL = `interval '${String(SUMMARY_DAYS)} days'`;
const TEST_RETENTION_SQL = `interval '${String(TEST_DAYS)} days'`;

type RunAlias = 'run' | 'workflow_runs';
type Clock = 'statement_timestamp()' | 'clock_timestamp()';
type RetentionKind = 'details' | 'summary';

function column(alias: RunAlias | undefined, name: string): string {
  return alias === undefined ? name : `${alias}.${name}`;
}

export function isTestRun(triggerType: string | undefined): boolean {
  return triggerType === TEST_TRIGGER_TYPE;
}

// Aliases and clocks are SQL literals supplied by query owners, never request data.
export function testRunSql(alias?: RunAlias): string {
  return `${column(alias, 'trigger_type')}='${TEST_TRIGGER_TYPE}'`;
}

export function ordinaryRunSql(alias?: RunAlias): string {
  return `${column(alias, 'trigger_type')} <> '${TEST_TRIGGER_TYPE}'`;
}

export function retainedTestRunSql(
  alias?: RunAlias,
  clock: Clock = 'statement_timestamp()',
): string {
  return `(${ordinaryRunSql(alias)} OR ${column(alias, 'created_at')}>${clock}-${TEST_RETENTION_SQL})`;
}

export function runRetentionIntervalSql(
  alias?: RunAlias,
  kind: RetentionKind = 'details',
): string {
  const ordinary =
    kind === 'details' ? RUN_DETAILS_RETENTION_SQL : RUN_SUMMARY_RETENTION_SQL;
  return `case when ${testRunSql(alias)} then ${TEST_RETENTION_SQL} else ${ordinary} end`;
}

export function expiredRunSql(
  alias: RunAlias,
  kind: RetentionKind = 'details',
): string {
  const created = column(alias, 'created_at');
  const completed = column(alias, 'completed_at');
  return `${completed} IS NOT NULL AND (case when ${testRunSql(alias)} then ${created} else ${completed} end) <= clock_timestamp() - ${runRetentionIntervalSql(alias, kind)}`;
}

export function runInputRetentionSql(triggerType: string): string {
  return isTestRun(triggerType)
    ? TEST_RETENTION_SQL
    : RUN_DETAILS_RETENTION_SQL;
}
