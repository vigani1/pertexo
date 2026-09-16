import { Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function SelectionToolbar({
  onRemove,
}: Readonly<{ onRemove: () => void }>) {
  return (
    <div
      className="absolute top-5 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-primary/20 bg-card/90 px-2.5 py-2 shadow-[0_14px_40px_rgb(0_0_0/34%),0_0_20px_rgb(0_229_255/8%)] backdrop-blur-xl"
      role="toolbar"
      aria-label="Canvas selection"
    >
      <span className="px-1 font-mono text-[0.68rem] text-muted-foreground">
        1 node selected
      </span>
      <Button type="button" size="sm" variant="destructive" onClick={onRemove}>
        <Trash2Icon data-icon="inline-start" />
        Remove
      </Button>
    </div>
  );
}
