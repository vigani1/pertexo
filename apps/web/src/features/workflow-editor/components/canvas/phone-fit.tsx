import { useStore } from '@xyflow/react';
import { MaximizeIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function PhoneCanvasFit({ onFit }: Readonly<{ onFit: () => void }>) {
  const zoom = useStore((state) => state.transform[2]);
  return (
    <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-2 sm:hidden">
      <output
        aria-label="Zoom"
        className="font-mono text-caption text-subtle-foreground"
      >
        {Math.round(zoom * 100)}%
      </output>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="lens"
        aria-label="Fit workflow to screen"
        onClick={onFit}
      >
        <MaximizeIcon aria-hidden="true" />
      </Button>
    </div>
  );
}
