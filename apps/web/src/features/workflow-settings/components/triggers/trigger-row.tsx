import type { ReactNode } from 'react';
import { Row } from '@/components/patterns/lists/row';
import { Disclosure } from '@/components/ui/disclosure';

/**
 * One way a run can start, as a row: its step, what kind it is, how it is
 * doing, the one switch only schedules have, and its controls folded away.
 */
export function TriggerRow({
  id,
  label,
  icon,
  name,
  kind,
  extra,
  state,
  control,
  details,
  detailsLabel = 'Manage',
}: Readonly<{
  id?: string;
  /** The row's accessible name, such as “Schedule: Nightly check”. */
  label: string;
  icon: ReactNode;
  name: string;
  /** The kind and its one-line rule, such as “Schedule · every 15 minutes”. */
  kind: ReactNode;
  /** A line under the kind, such as an address with its copy button. */
  extra?: ReactNode;
  /** How it is doing: a status mark and a time. */
  state: ReactNode;
  /** The switch, for the kinds that can be turned off on their own. */
  control?: ReactNode;
  details?: ReactNode;
  detailsLabel?: string;
}>) {
  return (
    <Row lift="none">
      <article
        id={id}
        aria-label={label}
        className="grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(5rem,9rem)_auto]"
      >
        <span className="pt-0.5">{icon}</span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="truncate text-lead font-semibold">{name}</h3>
          <p className="text-meta text-subtle-foreground">{kind}</p>
          {extra}
        </div>
        <div className="col-start-2 flex min-w-0 flex-col gap-0.5 pt-0.5 sm:col-start-auto">
          {state}
        </div>
        <div className="col-start-3 row-start-1 flex justify-end sm:col-start-auto sm:row-start-auto">
          {control}
        </div>
        {details === undefined ? null : (
          <Disclosure
            summary={detailsLabel}
            className="col-span-full sm:col-start-2"
            contentClassName="flex flex-col gap-4 pt-2 pb-1"
          >
            {details}
          </Disclosure>
        )}
      </article>
    </Row>
  );
}
