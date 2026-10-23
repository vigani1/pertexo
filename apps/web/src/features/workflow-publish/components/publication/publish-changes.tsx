import { MinusIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { SkeletonLines } from '@/components/ui/skeleton';
import type {
  PublishSummary,
  PublishSummaryLine,
} from '../../model/publication/summary';

const kindIcon = {
  added: PlusIcon,
  removed: MinusIcon,
  changed: PencilIcon,
} as const;

const kindClass = {
  added: 'text-success',
  removed: 'text-destructive',
  changed: 'text-secondary',
} as const;

const kindWord = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
} as const;

/** Steps added, removed and changed since the live version. */
export function PublishChanges({
  summary,
  state,
}: Readonly<{
  summary: PublishSummary | undefined;
  state: 'loading' | 'error' | 'ready';
}>) {
  if (state === 'loading')
    return <SkeletonLines label="Loading changes" lines={2} />;
  if (state === 'error' || summary === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        The live version couldn’t be loaded, so changes can’t be listed. You can
        still publish.
      </p>
    );
  const heading =
    summary.previousVersionNumber === null
      ? 'First version'
      : `Changes since v${String(summary.previousVersionNumber)}`;
  return (
    <section aria-label={heading}>
      <h3 className="text-sm font-semibold">{heading}</h3>
      {summary.lines.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {summary.layoutOnly
            ? 'Only the layout changed. Runs behave exactly as before.'
            : 'No definition changes. Publishing makes the same version live again.'}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {summary.lines.map((line) => (
            <ChangeLine key={`${line.kind}:${line.nodeId}`} line={line} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChangeLine({ line }: Readonly<{ line: PublishSummaryLine }>) {
  const Icon = kindIcon[line.kind];
  return (
    <li className="flex min-w-0 items-center gap-2">
      <Icon
        aria-hidden="true"
        className={`size-3.5 shrink-0 ${kindClass[line.kind]}`}
      />
      <span className="sr-only">{kindWord[line.kind]}:</span>
      <span className="truncate font-medium">{line.name}</span>
      {line.detail === undefined ? null : (
        <span className="truncate text-xs text-subtle-foreground">
          {line.detail}
        </span>
      )}
    </li>
  );
}
