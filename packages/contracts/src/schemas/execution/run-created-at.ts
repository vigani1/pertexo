import { z } from 'zod';
import { STORED_TIMESTAMP_FRACTION_DIGITS } from '@pertexo/workflow-model';

// Any precision PostgreSQL keeps, from whole seconds to microseconds.
const workflowRunCreatedAtInputSchema = z.union(
  Array.from({ length: STORED_TIMESTAMP_FRACTION_DIGITS + 1 }, (_, precision) =>
    z.iso.datetime({ offset: true, precision }),
  ),
);
// `YYYY-MM-DDTHH:MM:SS`, the whole seconds of an ISO timestamp.
const ISO_WHOLE_SECONDS_CHARACTERS = 19;

/** Canonical UTC form that preserves PostgreSQL's supported microseconds. */
export function normalizeWorkflowRunCreatedAt(value: string): string {
  const parsed = workflowRunCreatedAtInputSchema.parse(value);
  const match =
    /^(?<whole>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,6}))?(?<offset>Z|[+-]\d{2}:\d{2})$/u.exec(
      parsed,
    );
  if (match?.groups === undefined)
    throw new TypeError('workflow run timestamp is invalid');
  const { whole, fraction, offset } = match.groups;
  if (whole === undefined || offset === undefined)
    throw new TypeError('workflow run timestamp is invalid');
  const epochMilliseconds = Date.parse(`${whole}.000${offset}`);
  const utcWhole = new Date(epochMilliseconds)
    .toISOString()
    .slice(0, ISO_WHOLE_SECONDS_CHARACTERS);
  return `${utcWhole}.${(fraction ?? '').padEnd(STORED_TIMESTAMP_FRACTION_DIGITS, '0')}Z`;
}

export const workflowRunCreatedAtSchema =
  workflowRunCreatedAtInputSchema.transform(normalizeWorkflowRunCreatedAt);
