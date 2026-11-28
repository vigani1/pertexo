import { LayersIcon, PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/class-names';
import { CANVAS_COVER_ATTRIBUTE } from '../model/canvas/framing';
import type { MobilePanel } from '../hooks/use-inspector-navigation';

// The canvas frames steps in the area these lenses leave uncovered.
const covers = { [CANVAS_COVER_ATTRIBUTE]: '' };

/**
 * Places the editor's layers: the canvas fills the space above test history. The command
 * bar, add-step lens, inspector lens (or the assistant's panel in its place)
 * and the bottom lens (the issues lens, or the last test's bar) float above it. Under 1024px the two
 * lenses become bottom panels behind buttons, put away by a tap outside.
 * They stay mounted either way, so unfinished edits and navigation guards
 * survive switching panels.
 */
export function EditorLayout({
  header,
  canvas,
  addStep,
  inspector,
  assistant,
  overlay,
  bottomLens,
  history,
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
  assistant: ReactNode;
  overlay: ReactNode;
  bottomLens: ReactNode;
  history: ReactNode;
  panels: Readonly<{
    inspectorOpen: boolean;
    assistantOpen: boolean;
    addStepCollapsed: boolean;
    onOpenAddStep: () => void;
    editable: boolean;
    mobilePanel: MobilePanel;
    onMobilePanelChange: (panel: MobilePanel) => void;
  }>;
}>) {
  const {
    inspectorOpen,
    assistantOpen,
    addStepCollapsed,
    onOpenAddStep,
    editable,
    mobilePanel,
    onMobilePanelChange,
  } = panels;
  return (
    <div className="flex h-[calc(100svh-5rem)] min-h-0 md:h-svh flex-col overflow-hidden max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 max-sm:[&_summary]:min-h-11 max-sm:[&_a]:min-h-11">
      <div
        className="relative flex-1 min-h-0 overflow-hidden rounded-2xl bg-background"
        style={
          {
            '--editor-left-inset': addStepInset({ editable, addStepCollapsed }),
            '--editor-right-inset': inspectorInset(panels),
          } as CSSProperties
        }
      >
        {canvas}
        <PanelScrim panel={mobilePanel} onChange={onMobilePanelChange} />
        <div className="pointer-events-none absolute inset-0 flex flex-col gap-2 p-3 max-sm:gap-1.5 max-sm:p-2">
          {/* Above the dismiss layer: the bar stays usable with a panel open. */}
          <div className="pointer-events-auto relative z-40" {...covers}>
            {header.bar}
          </div>
          <div {...covers}>{header.banner}</div>
          <div {...covers}>{header.canvasTools}</div>
          <div className="relative min-h-0 flex-1">
            {editable ? (
              <aside
                id="editor-panel-add"
                aria-label="Add a step"
                {...covers}
                className={cn(
                  // A sheet on a phone; from 768px a side sheet, so the canvas
                  // stays in view beside it.
                  'lens pointer-events-auto absolute inset-x-0 top-0 bottom-16 z-40 flex-col rounded-xl md:right-auto md:w-80',
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
                'lens pointer-events-auto absolute inset-x-0 top-[38%] bottom-16 z-40 flex-col rounded-xl md:top-0 md:left-auto md:w-96',
                mobilePanel === 'inspector' && !assistantOpen
                  ? 'flex'
                  : 'hidden',
                'lg:absolute lg:inset-x-auto lg:top-0 lg:right-0 lg:bottom-0 lg:z-10 lg:h-auto lg:w-86',
                inspectorOpen ? 'lg:flex' : 'lg:invisible lg:flex',
              )}
            >
              {inspector}
            </aside>
            {assistant}
            {overlay}
            {bottomLens === null ? null : (
              // Clear of the zoom lens in the bottom-left corner at every size,
              // and from 1024px above the canvas toolbar.
              <div className="pointer-events-none absolute right-0 bottom-14 left-12 z-30 flex justify-center sm:left-52 lg:bottom-14 lg:left-[calc(var(--editor-left-inset)+10.25rem)] lg:right-[calc(var(--editor-right-inset)-0.75rem)]">
                <div className="w-full max-w-xl">{bottomLens}</div>
              </div>
            )}
          </div>
        </div>
        <nav
          aria-label="Editor panels"
          className="lens absolute right-3 bottom-3 z-40 flex gap-1 rounded-lg p-1 lg:hidden"
        >
          {editable ? (
            <PanelButton
              panel="add"
              current={mobilePanel}
              label="Add step"
              icon={<PlusIcon data-icon="inline-start" />}
              onChange={(panel) => {
                if (panel === 'add') onOpenAddStep();
                else onMobilePanelChange(panel);
              }}
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
      <div className="shrink-0 bg-background">{history}</div>
    </div>
  );
}

/** A tap outside closes the small-screen panel and keeps its draft. */
function PanelScrim({
  panel,
  onChange,
}: Readonly<{ panel: MobilePanel; onChange: (panel: MobilePanel) => void }>) {
  if (panel === 'none') return null;
  return (
    <div
      aria-hidden="true"
      data-slot="panel-dismiss"
      className="fixed inset-0 z-30 bg-recess-ink/15 lg:hidden"
      onClick={() => {
        onChange('none');
      }}
    />
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

function inspectorInset(
  panels: Readonly<{ assistantOpen: boolean; inspectorOpen: boolean }>,
): string {
  if (panels.assistantOpen) return '26.75rem';
  return panels.inspectorOpen ? '22.25rem' : '0.75rem';
}
