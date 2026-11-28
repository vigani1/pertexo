import { ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const COLLAPSED_LIST_COUNT = 5;
export const SEARCH_LIST_THRESHOLD = 20;

export function ShowAll({
  count,
  subject,
  controls,
  expanded,
  onExpandedChange,
}: Readonly<{
  count: number;
  subject?: string;
  controls: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}>) {
  if (count <= COLLAPSED_LIST_COUNT) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-controls={controls}
      aria-expanded={expanded}
      onClick={() => {
        onExpandedChange(!expanded);
      }}
    >
      {expanded
        ? 'Show fewer'
        : `Show all ${String(count)}${subject === undefined ? '' : ` ${subject}`}`}
      <ChevronDownIcon
        aria-hidden="true"
        className="group-aria-expanded/button:rotate-180"
      />
    </Button>
  );
}
