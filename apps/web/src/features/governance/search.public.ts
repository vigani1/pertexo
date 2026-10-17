import { auditFilterSchema, type AuditFilter } from '@pertexo/contracts';
export function parseAuditSearch(
  value: Readonly<Record<string, unknown>>,
): AuditFilter {
  const parsed = auditFilterSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
