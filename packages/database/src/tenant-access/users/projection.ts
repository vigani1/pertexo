import { users } from '../../schema/foundation.js';
import type { UserRecord } from '../contract.js';

export const userSelection = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  status: users.status,
  profileRevision: users.profileRevision,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

/** Keep the existing display normalization without parsing trusted records again. */
export function userRecord(record: UserRecord): UserRecord {
  return Object.freeze({
    ...record,
    email: record.email.trim(),
    displayName: record.displayName.trim(),
  });
}
