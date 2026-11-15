import { z } from 'zod';

const workflowRunCreatedAtInputSchema = z.union([
  z.iso.datetime({ offset: true, precision: 0 }),
  z.iso.datetime({ offset: true, precision: 1 }),
  z.iso.datetime({ offset: true, precision: 2 }),
  z.iso.datetime({ offset: true, precision: 3 }),
  z.iso.datetime({ offset: true, precision: 4 }),
  z.iso.datetime({ offset: true, precision: 5 }),
  z.iso.datetime({ offset: true, precision: 6 }),
]);

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
  const utcWhole = new Date(epochMilliseconds).toISOString().slice(0, 19);
  return `${utcWhole}.${(fraction ?? '').padEnd(6, '0')}Z`;
}

export const workflowRunCreatedAtSchema =
  workflowRunCreatedAtInputSchema.transform(normalizeWorkflowRunCreatedAt);
