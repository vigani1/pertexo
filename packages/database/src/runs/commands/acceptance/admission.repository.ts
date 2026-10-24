import { sql } from 'drizzle-orm';

import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';

import {
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from './errors.js';

type AdmissionSqlState = 'PTA01' | 'PTA02';

function inspectAdmissionSqlState(error: unknown): AdmissionSqlState | null {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = current;
    const invalidStoredValue =
      (typeof candidate !== 'object' && typeof candidate !== 'function') ||
      candidate === null;
    if (invalidStoredValue) return null;
    if (visited.has(candidate)) return null;
    visited.add(candidate);
    try {
      if (!(candidate instanceof Error)) return null;
      const code = Reflect.get(candidate, 'code') as unknown;
      if (code === 'PTA01' || code === 'PTA02') return code;
      current = Reflect.get(candidate, 'cause');
    } catch {
      return null;
    }
  }
  return null;
}

/** Operation-local SQLSTATE mapping for queued workflow-run admission. */
export function throwWorkflowRunAdmissionError(error: unknown): never {
  const code = inspectAdmissionSqlState(error);
  if (code === 'PTA02') throw new WorkspaceRunQuotaExceededError();
  if (code === 'PTA01') throw new WorkspaceRunAdmissionDeniedError();
  throw error;
}

export async function assertWorkspaceAcceptsNewRuns(
  transaction: WorkspaceTransaction,
): Promise<void> {
  const result = await transaction.db.execute<{ status: string }>(sql`
    select app.lock_workspace_run_admission(${transaction.workspaceId}) status
  `);

  if (result.rows[0]?.status !== 'active') {
    throw new WorkspaceRunAdmissionDeniedError();
  }
}
