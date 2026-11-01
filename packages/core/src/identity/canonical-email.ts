import { sql, type SQLWrapper } from 'drizzle-orm';

/**
 * `canonicalEmail` in SQL, for finding a stored address. Stored addresses need
 * not be canonical: rows written before the shared rule were only lowercased.
 * `users_email_canonical_idx` serves this exact expression.
 */
export function canonicalEmailSql(address: SQLWrapper) {
  return sql`lower(normalize((${address})::text,NFKC))`;
}
