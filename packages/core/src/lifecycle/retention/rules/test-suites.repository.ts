import { workflowTestSuites } from '@pertexo/database/schema';
import { lte, sql } from 'drizzle-orm';
import { deletionRule } from '../../../shared/retention-deletion.js';

const suiteExpired = lte(workflowTestSuites.expiresAt, sql`clock_timestamp()`);

export const testSuites = deletionRule('workflow_test_suites', {
  table: workflowTestSuites,
  keys: [workflowTestSuites.id],
  condition: suiteExpired,
  orderBy: [workflowTestSuites.expiresAt, workflowTestSuites.id],
  recheck: suiteExpired,
});
