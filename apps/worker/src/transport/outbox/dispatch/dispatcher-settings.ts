import type { JobName } from '@pertexo/queue/server';

import { OutboxJobAllowlistError } from './outbox-dispatch.errors.js';

/** The most job names one dispatcher may publish. */
const OUTBOX_JOB_ALLOWLIST_LIMIT = 64;

/** The dispatcher's job allowlist: unique names, within the limit. */
export function admitJobAllowlist(
  jobNames: Iterable<JobName>,
): readonly JobName[] {
  const names = [...jobNames];
  if (
    names.length > OUTBOX_JOB_ALLOWLIST_LIMIT ||
    new Set(names).size !== names.length
  )
    throw new OutboxJobAllowlistError(
      `Outbox job allowlist must be unique and contain at most ${String(OUTBOX_JOB_ALLOWLIST_LIMIT)} entries`,
    );
  return Object.freeze(names);
}
