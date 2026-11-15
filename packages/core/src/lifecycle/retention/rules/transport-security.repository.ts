import { transportSecurityAuditFacts } from '@pertexo/database/schema';
import { sql } from 'drizzle-orm';
import { deletionRule } from '../../../shared/retention-deletion.repository.js';
import { DAY_INTERVAL } from '../../../shared/sql-intervals.repository.js';

/** How long a transport security fact is kept. */
const TRANSPORT_FACT_RETENTION_DAYS = 365;

export const transportFacts = deletionRule('transport_security_audit_facts', {
  table: transportSecurityAuditFacts,
  keys: [transportSecurityAuditFacts.id],
  condition: sql`${transportSecurityAuditFacts.occurredAt}<=clock_timestamp()-${TRANSPORT_FACT_RETENTION_DAYS}*${DAY_INTERVAL}`,
  orderBy: [
    transportSecurityAuditFacts.occurredAt,
    transportSecurityAuditFacts.id,
  ],
});
