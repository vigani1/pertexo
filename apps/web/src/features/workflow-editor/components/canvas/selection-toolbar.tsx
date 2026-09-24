import { Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function SelectionToolbar({
  onRemove,
}: Readonly<{ onRemove: () => void }>) {
  return (
    <div
      className="absolute top-5 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-primary/20 bg-card/90 p-2.5 shadow-lg shadow-primary/10 backdrop-blur-xl"
      role="toolbar"
      aria-label="Canvas selection"
    >
      <span className="px-1 font-mono text-xs text-muted-foreground">
        1 node selected
      </span>
      <Button type="button" size="sm" variant="destructive" onClick={onRemove}>
        <Trash2Icon data-icon="inline-start" />
        Remove
      </Button>
    </div>
  );
}
