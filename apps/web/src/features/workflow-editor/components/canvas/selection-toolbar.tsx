import { CopyPlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { useEditorStore } from '../../model/editor-store-context';

/**
 * Commands for several selected steps or connections at once, floating over
 * the canvas. A single step's commands live in its inspector instead.
 */
export function SelectionToolbar({
  editable,
  onDuplicate,
  onDelete,
}: Readonly<{
  editable: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
}>) {
  const nodeCount = useEditorStore((state) => state.selectedNodeIds.length);
  const edgeCount = useEditorStore((state) => state.selectedEdgeIds.length);
  if (!editable || nodeCount + edgeCount < 2) return null;
  const parts = [
    nodeCount > 0
      ? `${String(nodeCount)} ${nodeCount === 1 ? 'step' : 'steps'}`
      : undefined,
    edgeCount > 0
      ? `${String(edgeCount)} ${edgeCount === 1 ? 'connection' : 'connections'}`
      : undefined,
  ].filter((part) => part !== undefined);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
      <div
        role="toolbar"
        aria-label="Canvas selection"
        className="lens pointer-events-auto flex items-center gap-2 rounded-md py-1.5 pr-1.5 pl-3"
      >
        <span className="font-mono text-xs text-muted-foreground">
          {parts.join(' · ')} selected
        </span>
        {nodeCount > 0 ? (
          <Button type="button" size="sm" variant="ghost" onClick={onDuplicate}>
            <CopyPlusIcon data-icon="inline-start" />
            Duplicate
            <Kbd>⌘D</Kbd>
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="destructive"
          onClick={onDelete}
        >
          <Trash2Icon data-icon="inline-start" />
          Delete
        </Button>
      </div>
    </div>
  );
}
