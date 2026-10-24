import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableQuery } from '@pertexo/node-sdk';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FORMAT_LOCALE } from '@/lib/format/locale';

export function RowsPager({
  table,
  query,
  shown,
  pending,
  hasMore,
  onPrevious,
  onNext,
}: Readonly<{
  table: DataTableDefinition;
  query: DataTableQuery;
  shown: number;
  pending: boolean;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
}>) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-surface-ink/8 px-4 py-2 text-xs text-muted-foreground">
      <p className="font-mono tabular-nums" aria-live="polite">
        {shown === 0
          ? 'No rows shown'
          : `Rows ${String(query.offset + 1)}–${String(query.offset + shown)}`}
        {query.filters.length === 0
          ? ` of ${table.rowCount.toLocaleString(FORMAT_LOCALE)}`
          : ' · filtered'}
      </p>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Previous rows"
          disabled={query.offset === 0 || pending}
          onClick={onPrevious}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Next rows"
          disabled={!hasMore || pending}
          onClick={onNext}
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
