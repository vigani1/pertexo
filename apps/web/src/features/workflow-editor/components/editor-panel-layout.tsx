import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type EditorPanel = 'palette' | 'canvas' | 'inspector';

export function EditorPanelLayout({
  canUpdate,
  current,
  onSelect,
  palette,
  canvas,
  inspector,
}: Readonly<{
  canUpdate: boolean;
  current: EditorPanel;
  onSelect: (panel: EditorPanel) => void;
  palette?: ReactNode;
  canvas: ReactNode;
  inspector: ReactNode;
}>) {
  return (
    <>
      <nav
        className={cn(
          'grid gap-1 border-b border-white/8 bg-card/65 p-2 xl:hidden',
          canUpdate ? 'grid-cols-3' : 'grid-cols-2',
        )}
        aria-label="Workflow editor panels"
      >
        {canUpdate ? (
          <EditorPanelButton
            panel="palette"
            current={current}
            onSelect={onSelect}
          >
            Nodes
          </EditorPanelButton>
        ) : null}
        <EditorPanelButton panel="canvas" current={current} onSelect={onSelect}>
          Canvas
        </EditorPanelButton>
        <EditorPanelButton
          panel="inspector"
          current={current}
          onSelect={onSelect}
        >
          Inspector
        </EditorPanelButton>
      </nav>
      <div
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1',
          canUpdate
            ? 'xl:grid-cols-[13rem_minmax(0,1fr)_22rem]'
            : 'xl:grid-cols-[minmax(0,1fr)_22rem]',
        )}
      >
        {canUpdate ? (
          <div
            id="editor-panel-palette"
            role="region"
            aria-label="Node palette"
            className={cn(
              'min-h-0 [&>aside]:h-full',
              current === 'palette' ? 'block' : 'hidden',
              'xl:block',
            )}
          >
            {palette}
          </div>
        ) : null}
        <div
          id="editor-panel-canvas"
          role="region"
          aria-label="Workflow canvas"
          className={cn(
            'min-h-0 min-w-0',
            current === 'canvas' ? 'block' : 'hidden',
            'xl:block',
          )}
        >
          {canvas}
        </div>
        <div
          id="editor-panel-inspector"
          role="region"
          aria-label="Node inspector"
          className={cn(
            'min-h-0 [&>aside]:h-full',
            current === 'inspector' ? 'block' : 'hidden',
            'xl:block',
          )}
        >
          {inspector}
        </div>
      </div>
    </>
  );
}

function EditorPanelButton({
  panel,
  current,
  onSelect,
  children,
}: Readonly<{
  panel: EditorPanel;
  current: EditorPanel;
  onSelect: (panel: EditorPanel) => void;
  children: string;
}>) {
  const selected = current === panel;
  return (
    <Button
      id={`editor-panel-tab-${panel}`}
      type="button"
      size="sm"
      variant={selected ? 'primary' : 'ghost'}
      aria-pressed={selected}
      aria-controls={`editor-panel-${panel}`}
      onClick={() => {
        onSelect(panel);
      }}
    >
      {children}
    </Button>
  );
}
