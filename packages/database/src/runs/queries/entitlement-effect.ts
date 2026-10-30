import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

type EntitlementVersion = Readonly<{
  status: SQLWrapper;
  effectiveAt: SQLWrapper;
  expiresAt: SQLWrapper;
}>;

export type EntitlementPolicyState =
  'suspended' | 'not_yet_effective' | 'expired' | 'active';

/**
 * Whether an entitlement version is in effect at `clock`. Every reader uses this
 * so they agree with the admission trigger, which keeps its own copy in SQL
 * (`concurrency-admission/agrees-on-entitlement-effect` holds the two together).
 */
export function entitlementInEffect(
  version: EntitlementVersion,
  clock: SQL,
): SQL<boolean> {
  return sql`(${version.status}='active' and ${version.effectiveAt}<=${clock} and (${version.expiresAt} is null or ${version.expiresAt}>${clock}))`;
}

/** The same rule, naming why a version is not in effect. */
export function entitlementPolicyState(
  version: EntitlementVersion,
  clock: SQL,
): SQL<EntitlementPolicyState> {
  return sql`case when ${version.status}<>'active' then 'suspended' when ${version.effectiveAt}>${clock} then 'not_yet_effective' when ${version.expiresAt}<=${clock} then 'expired' else 'active' end`;
}
