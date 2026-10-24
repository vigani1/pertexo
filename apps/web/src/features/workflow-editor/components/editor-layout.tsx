import { LayersIcon, PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CANVAS_COVER_ATTRIBUTE } from '../model/canvas/framing';
import type { MobilePanel } from '../hooks/use-inspector-navigation';

// The canvas frames steps in the area these lenses leave uncovered.
const covers = { [CANVAS_COVER_ATTRIBUTE]: '' };

/**
 * Places the editor's layers: the canvas fills the screen, and the command
 * bar, add-step lens, inspector lens and the bottom lens (the issues
 * lens, or the last test's bar) float above it. Under 1024px the two
 * lenses become bottom panels behind buttons, put away by a tap outside.
 * They stay mounted either way, so unfinished edits and navigation guards
 * survive switching panels.
 */
export function EditorLayout({
  header,
  canvas,
  addStep,
  inspector,
  overlay,
  bottomLens,
  panels,
}: Readonly<{
  header: Readonly<{
    bar: ReactNode;
    canvasTools: ReactNode;
    banner: ReactNode;
  }>;
  canvas: ReactNode;
  addStep: ReactNode;
  inspector: ReactNode;
  overlay: ReactNode;
  bottomLens: ReactNode;
  panels: Readonly<{
    inspectorOpen: boolean;
    addStepCollapsed: boolean;
    editable: boolean;
    mobilePanel: MobilePanel;
    onMobilePanelChange: (panel: MobilePanel) => void;
  }>;
}>) {
  const { bar, canvasTools, banner } = header;
  const {
    inspectorOpen,
    addStepCollapsed,
    editable,
    mobilePanel,
    onMobilePanelChange,
  } = panels;
  const leftInset = addStepInset({ editable, addStepCollapsed });
  return (
    <div
      className="relative h-svh min-h-0 overflow-hidden bg-background"
      style={
        {
          '--editor-left-inset': leftInset,
          '--editor-right-inset': inspectorOpen ? '22.25rem' : '0.75rem',
        } as CSSProperties
      }
    >
      {canvas}
      {mobilePanel === 'none' ? null : (
        // Below 1024px a panel is a sheet: a tap anywhere outside puts it
        // away, like any phone sheet. Its edits stay, since it stays mounted.
        <div
          aria-hidden="true"
          data-slot="panel-dismiss"
          className="fixed inset-0 z-30 bg-recess-ink/15 lg:hidden"
          onClick={() => {
            onMobilePanelChange('none');
          }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 flex flex-col gap-2 p-3">
        {/* Above the dismiss layer: the bar stays usable with a panel open. */}
        <div className="pointer-events-auto relative z-40" {...covers}>
          {bar}
        </div>
        <div {...covers}>{banner}</div>
        {canvasTools}
        <div className="relative min-h-0 flex-1">
          {editable ? (
            <aside
              id="editor-panel-add"
              aria-label="Add a step"
              {...covers}
              className={cn(
                // A sheet on a phone; from 768px a side sheet, so the canvas
                // stays in view beside it.
                'lens pointer-events-auto fixed inset-x-2 bottom-16 z-40 max-h-[62svh] flex-col rounded-xl md:right-auto md:w-80 md:max-h-[calc(100svh-15rem)]',
                mobilePanel === 'add' ? 'flex' : 'hidden',
                'lg:absolute lg:inset-x-auto lg:top-0 lg:bottom-0 lg:left-0 lg:z-10 lg:flex lg:max-h-none',
                // Folded, it's just its button, not an empty rail.
                addStepCollapsed ? 'lg:bottom-auto lg:w-11' : 'lg:w-63',
              )}
            >
              {addStep}
            </aside>
          ) : null}
          <aside
            id="editor-panel-inspector"
            aria-label="Step panel"
            data-open={inspectorOpen}
            {...covers}
            className={cn(
              'lens pointer-events-auto fixed inset-x-2 bottom-16 z-40 h-[68svh] flex-col rounded-xl md:left-auto md:w-96 md:h-[calc(100svh-15rem)]',
              mobilePanel === 'inspector' ? 'flex' : 'hidden',
              'lg:absolute lg:inset-x-auto lg:top-0 lg:right-0 lg:bottom-0 lg:z-10 lg:h-auto lg:w-86',
              inspectorOpen ? 'lg:flex' : 'lg:hidden',
            )}
          >
            {inspector}
          </aside>
          {overlay}
          {bottomLens === null ? null : (
            // Clear of the zoom lens in the bottom-left corner at every size.
            <div className="pointer-events-none absolute right-0 bottom-14 left-12 z-30 flex justify-center sm:left-52 lg:bottom-0 lg:left-[calc(var(--editor-left-inset)+10.25rem)] lg:right-[calc(var(--editor-right-inset)-0.75rem)]">
              <div className="w-full max-w-xl">{bottomLens}</div>
            </div>
          )}
        </div>
      </div>
      <nav
        aria-label="Editor panels"
        className="lens fixed right-3 bottom-3 z-40 flex gap-1 rounded-lg p-1 lg:hidden"
      >
        {editable ? (
          <PanelButton
            panel="add"
            current={mobilePanel}
            label="Add step"
            icon={<PlusIcon data-icon="inline-start" />}
            onChange={onMobilePanelChange}
          />
        ) : null}
        <PanelButton
          panel="none"
          current={mobilePanel}
          label="Canvas"
          icon={<LayersIcon data-icon="inline-start" />}
          onChange={onMobilePanelChange}
        />
        <PanelButton
          panel="inspector"
          current={mobilePanel}
          label="Step"
          icon={<SlidersHorizontalIcon data-icon="inline-start" />}
          // A selected step has something to show here: a dot says so.
          cue={inspectorOpen && mobilePanel !== 'inspector'}
          onChange={onMobilePanelChange}
        />
      </nav>
    </div>
  );
}

function PanelButton({
  panel,
  current,
  label,
  icon,
  cue = false,
  onChange,
}: Readonly<{
  panel: MobilePanel;
  current: MobilePanel;
  label: string;
  icon: ReactNode;
  cue?: boolean;
  onChange: (panel: MobilePanel) => void;
}>) {
  const selected = current === panel;
  return (
    <Button
      type="button"
      size="sm"
      variant={selected ? 'default' : 'ghost'}
      aria-pressed={selected}
      {...(panel === 'none'
        ? {}
        : {
            'aria-controls':
              panel === 'add' ? 'editor-panel-add' : 'editor-panel-inspector',
          })}
      onClick={() => {
        onChange(selected && panel !== 'none' ? 'none' : panel);
      }}
    >
      {icon}
      {label}
      {cue ? (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-action" />
      ) : null}
    </Button>
  );
}

function addStepInset({
  editable,
  addStepCollapsed,
}: Readonly<{ editable: boolean; addStepCollapsed: boolean }>): string {
  if (!editable) return '0.75rem';
  return addStepCollapsed ? '4rem' : '17rem';
}
