import { timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

const LEASE_OWNER_CHARACTERS = 128;

export function triggerLeaseColumns() {
  return {
    leaseOwner: varchar('lease_owner', { length: LEASE_OWNER_CHARACTERS }),
    leaseToken: uuid('lease_token'),
    leaseAcquiredAt: timestamp('lease_acquired_at', {
      withTimezone: true,
      mode: 'date',
    }),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
  };
}
