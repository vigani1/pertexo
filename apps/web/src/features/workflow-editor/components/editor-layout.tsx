import { LayersIcon, PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CANVAS_COVER_ATTRIBUTE } from '../model/canvas-framing';
import type { MobilePanel } from '../use-inspector-navigation';

// The canvas frames steps in the area these lenses leave uncovered.
const covers = { [CANVAS_COVER_ATTRIBUTE]: '' };

/**
 * Places the editor's layers: the canvas fills the screen, and the command
 * bar, add-step lens, inspector lens and the bottom lens (the issues
 * lens, or the last test's bar) float above it. Under 1024px the two
 * lenses become bottom panels behind buttons. They stay mounted either way,
 * so unfinished edits and navigation guards survive switching panels.
 */
export function EditorLayout({
  bar,
  banner,
  canvas,
  addStep,
  inspector,
  inspectorOpen,
  overlay,
  bottomLens,
  addStepCollapsed,
  editable,
  mobilePanel,
  onMobilePanelChange,
}: Readonly<{
  bar: ReactNode;
  banner: ReactNode;
  canvas: ReactNode;
  addStep: ReactNode;
  inspector: ReactNode;
  inspectorOpen: boolean;
  overlay: ReactNode;
  /** A lens at the bottom, between the zoom controls and the inspector. */
  bottomLens: ReactNode;
  addStepCollapsed: boolean;
  editable: boolean;
  mobilePanel: MobilePanel;
  onMobilePanelChange: (panel: MobilePanel) => void;
}>) {
  const leftInset = !editable ? '0.75rem' : addStepCollapsed ? '4rem' : '17rem';
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
      <div className="pointer-events-none absolute inset-0 flex flex-col gap-2 p-3">
        <div className="pointer-events-auto" {...covers}>
          {bar}
        </div>
        {banner}
        <div className="relative min-h-0 flex-1">
          {editable ? (
            <aside
              id="editor-panel-add"
              aria-label="Add a step"
              {...covers}
              className={cn(
                'lens pointer-events-auto fixed inset-x-2 bottom-16 z-40 max-h-[62svh] flex-col rounded-xl',
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
              'lens pointer-events-auto fixed inset-x-2 bottom-16 z-40 h-[68svh] flex-col rounded-xl',
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
