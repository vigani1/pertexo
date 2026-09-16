import { SlidersHorizontalIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function NodeInspectorHeader({
  label,
  definitionIdentity,
  family,
  supported,
}: Readonly<{
  label: string;
  definitionIdentity: string;
  family: string;
  supported: boolean;
}>) {
  return (
    <div className="border-b border-white/8 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[0.64rem] tracking-[0.14em] text-primary/75 uppercase">
            Selected node
          </p>
          <h2 className="mt-1 truncate font-heading text-lg font-semibold">
            {label}
          </h2>
        </div>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
          <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-white/6 bg-black/20 px-3 py-2">
        <p className="min-w-0 truncate font-mono text-[0.66rem] text-muted-foreground">
          {definitionIdentity}
        </p>
        <Badge variant={supported ? 'muted' : 'secondary'}>
          {supported ? family : 'Unsupported'}
        </Badge>
      </div>
    </div>
  );
}
