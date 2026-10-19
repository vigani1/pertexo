import { Button } from '@/components/ui/button';

export function HistoryPager({
  label,
  start,
  end,
  total,
  page,
  pages,
  onPage,
}: Readonly<{
  label: string;
  start: number;
  end: number;
  total: number;
  page: number;
  pages: number;
  onPage: (page: number) => void;
}>) {
  if (pages <= 1) return null;
  return (
    <nav
      aria-label={label}
      className="mt-3 flex flex-wrap items-center justify-between gap-2"
    >
      <span
        className="font-mono text-xs text-muted-foreground"
        aria-live="polite"
      >
        {(start + 1).toLocaleString()}–{end.toLocaleString()} of{' '}
        {total.toLocaleString()}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0}
          onClick={() => {
            onPage(page - 1);
          }}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page + 1 >= pages}
          onClick={() => {
            onPage(page + 1);
          }}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
