import { sql } from 'drizzle-orm';
import { workspaces } from '../../schema/foundation.js';
import type { WorkspaceRecord } from '../contract.js';

export const workspaceSelection = {
  id: workspaces.id,
  name: workspaces.name,
  slug: workspaces.slug,
  status: workspaces.status,
  revision: workspaces.revision,
  // Creation returns an active row; rename checks active status before projection.
  // The deletion-state constraint guarantees its creator is present.
  createdBy: sql<string>`${workspaces.createdBy}`,
  deletionRequestedAt: workspaces.deletionRequestedAt,
  deletionRequestedBy: workspaces.deletionRequestedBy,
  deletionReason: workspaces.deletionReason,
  purgeAfter: workspaces.purgeAfter,
  createdAt: workspaces.createdAt,
  updatedAt: workspaces.updatedAt,
};

/** A normalized name must still make a rename a no-op, including older stored text. */
export function workspaceRecord(record: WorkspaceRecord): WorkspaceRecord {
  return Object.freeze({
    ...record,
    name: record.name.trim(),
    deletionReason: record.deletionReason?.trim() ?? null,
  });
}
