import { transportSecurityAuditFacts } from '@pertexo/database/schema';
import { sql } from 'drizzle-orm';
import { deletionRule } from '../../../shared/retention-deletion.js';

export const transportFacts = deletionRule('transport_security_audit_facts', {
  table: transportSecurityAuditFacts,
  keys: [transportSecurityAuditFacts.id],
  condition: sql`${transportSecurityAuditFacts.occurredAt}<=clock_timestamp()-interval '365 days'`,
  orderBy: [
    transportSecurityAuditFacts.occurredAt,
    transportSecurityAuditFacts.id,
  ],
});
