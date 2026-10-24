import { useQuery } from '@tanstack/react-query';
import { stepSamplesQueryOptions } from '@/features/workflow-publish/step-samples.public';
import type { ComponentProps, RefObject } from 'react';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { WorkflowTestDialog } from '@/features/workflow-publish/workflow-tests.public';
import { QuickAddLens } from './add-step/quick-add-lens';
import { SelectionToolbar } from './canvas/selection-toolbar';
import { StartPicker } from './canvas/start-picker';
import { ValidationSweep } from './canvas/validation-sweep';
import { WorkflowCanvas } from './canvas/index';
import type { useCanvasEditing } from './workspace-canvas';

type CanvasEditing = ReturnType<typeof useCanvasEditing>;
type SurfaceProps = Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  editable: boolean;
  overlays: ComponentProps<typeof WorkflowCanvas>['overlays'];
  sampleScope: Parameters<typeof stepSamplesQueryOptions>[0];
  readSamples: boolean;
  canvas: Pick<CanvasEditing, 'canvasRef' | 'adding' | 'selection'>;
  checking: boolean;
  onOpenInspector: () => void;
}>;
export function WorkspaceSurface({
  definitions,
  editable,
  overlays,
  sampleScope,
  readSamples,
  canvas,
  checking,
  onOpenInspector,
}: SurfaceProps) {
  const { canvasRef, adding, selection } = canvas;
  const samples = useQuery({
    ...stepSamplesQueryOptions(sampleScope),
    enabled: readSamples,
  });
  return (
    <WorkflowCanvas
      definitions={definitions}
      editable={editable}
      overlays={overlays}
      samples={samples.isError ? undefined : samples.data?.items}
      containerRef={canvasRef}
      onSelectNodes={selection.selectNodes}
      onRemoveEdge={selection.removeEdge}
      onDropStep={adding.placement.addAt}
      onPortDrop={adding.quickAdd.openAtDrop}
      onAddToBody={adding.addToBody}
      onOpenStep={() => {
        // The first tap already selected it; this only brings its panel
        // up where panels fold away, and leaves the tab as it was.
        onOpenInspector();
      }}
    >
      <StartPicker
        definitions={definitions}
        editable={editable}
        onPick={adding.placement.addAtCentre}
      />
      <ValidationSweep active={checking} />
    </WorkflowCanvas>
  );
}
type OverlayProps = Readonly<{
  feedbackTarget: (target: HTMLDivElement | null) => void;
  editable: boolean;
  paused: boolean;
  testing: ComponentProps<typeof WorkflowTestDialog>;
  selection: CanvasEditing['selection'];
  adding: CanvasEditing['adding'];
  definitions: readonly NodeDefinitionCatalogItem[];
  canvasRef: RefObject<HTMLDivElement | null>;
}>;
export function WorkspaceOverlay({
  feedbackTarget: setFeedbackTarget,
  editable,
  paused,
  testing,
  selection,
  adding,
  definitions: placeable,
  canvasRef,
}: OverlayProps) {
  const { tests, workspace, workflow, graph } = testing;
  const { quickAdd } = adding;
  return (
    <>
      <div
        ref={setFeedbackTarget}
        className="pointer-events-none absolute inset-0 z-40"
      />
      {paused || !tests.open ? null : (
        <WorkflowTestDialog
          tests={tests}
          workspace={workspace}
          workflow={workflow}
          graph={graph}
        />
      )}
      <SelectionToolbar
        editable={editable}
        onDuplicate={selection.duplicateSelection}
        onDelete={selection.deleteSelection}
      />
      <QuickAddLens
        // It renders in a portal, outside the workspace a pause makes inert.
        request={editable && !paused ? quickAdd.request : undefined}
        definitions={placeable}
        fallbackFocus={canvasRef}
        onPortChange={quickAdd.choosePort}
        onChoose={quickAdd.choose}
        onClose={quickAdd.close}
      />
    </>
  );
}
