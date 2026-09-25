import { ChartGanttIcon, ListIcon } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** The Live switch (10 s polling while visible) and the List | Loom view. */
export function RunsToolbar({
  live,
  onLiveChange,
  view,
  onViewChange,
}: Readonly<{
  live: boolean;
  onLiveChange: (live: boolean) => void;
  view: 'list' | 'loom';
  onViewChange: (view: 'list' | 'loom') => void;
}>) {
  return (
    <>
      <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Switch checked={live} onCheckedChange={onLiveChange} />
        Auto-refresh
      </label>
      <ToggleGroup
        aria-label="View"
        value={[view]}
        onValueChange={(values) => {
          const [next] = values;
          if (next === 'list' || next === 'loom') onViewChange(next);
        }}
      >
        <ToggleGroupItem value="list">
          <ListIcon aria-hidden="true" />
          List
        </ToggleGroupItem>
        <ToggleGroupItem value="loom">
          <ChartGanttIcon aria-hidden="true" />
          Loom
        </ToggleGroupItem>
      </ToggleGroup>
    </>
  );
}
