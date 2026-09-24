import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { Connection } from '@xyflow/react';
import { CheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useEditorStore,
  useEditorStoreApi,
} from '../../model/editor-store-context';
import type { EditorFocusTarget } from '../../model/use-editor-actions';
import type { InspectorTab } from '../../model/use-inspector-navigation';
import { updateWorkflowNode } from '../../model/graph-commands';
import { createScratchTracker } from '../../model/use-live-field';
import { AboutTab } from './about-tab';
import { InputsTab } from './inputs-tab';
import { InspectorHeader, type StepMenuActions } from './inspector-header';
import { fieldControlId, type NodeFormApi } from './node-form';
import { SetupTab } from './setup-tab';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export type NodeInspectorActions = StepMenuActions &
  Readonly<{
    onConnect: (connection: Connection) => void;
    onRemoveEdge: (edgeId: string) => void;
    onDiscardScratch: () => void;
  }>;

/**
 * One step's inspector. Keyed by step, so its local scratch never leaks to
 * another step; every valid edit is applied to the draft as it happens.
 */
export function NodeInspector({
  node,
  graph,
  definition,
  definitions,
  connections,
  workspaceId,
  editable,
  tab,
  onTabChange,
  focusTarget,
  testPanel,
  actions,
}: Readonly<{
  node: WorkflowNode;
  graph: WorkflowGraphContract;
  definition: NodeDefinitionCatalogItem | undefined;
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  workspaceId: string;
  editable: boolean;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  focusTarget:
    (EditorFocusTarget & Readonly<{ requestId: number }>) | undefined;
  testPanel: ReactNode;
  actions: NodeInspectorActions;
}>) {
  const store = useEditorStoreApi();
  const scratch = useEditorStore((state) => state.inspectorScratch);
  const panelRef = useRef<HTMLDivElement>(null);
  const [reportScratch] = useState(() =>
    createScratchTracker((hasScratch) => {
      store.getState().setInspectorScratch(hasScratch);
    }),
  );
  const form = useMemo<NodeFormApi>(
    () => ({
      nodeId: node.id,
      editable,
      reportScratch,
      commit: (update, coalesceKey) => {
        const state = store.getState();
        const current = state.graph.nodes.find((item) => item.id === node.id);
        if (current === undefined) return;
        const resolved =
          typeof update === 'function' ? update(current) : update;
        state.transact(updateWorkflowNode(state.graph, node.id, resolved), {
          coalesceKey,
        });
      },
    }),
    [editable, node.id, reportScratch, store],
  );

  useEffect(() => {
    if (focusTarget?.nodeId !== node.id) return;
    const panel = panelRef.current;
    const element =
      focusTarget.mappingKey === undefined
        ? document.getElementById(
            focusTarget.fieldKey === undefined
              ? `node-label-${node.id}`
              : fieldControlId(node.id, focusTarget.fieldKey),
          )
        : [
            ...(panel?.querySelectorAll<HTMLInputElement>(
              'input[name$=".key"]',
            ) ?? []),
          ].find((input) => input.value === focusTarget.mappingKey);
    element?.focus();
    pulse(element?.closest('[data-slot="field"]') ?? element);
  }, [focusTarget, node.id]);

  return (
    <div ref={panelRef} className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pt-4">
        <InspectorHeader
          node={node}
          definition={definition}
          form={form}
          actions={actions}
        />
      </div>
      <Tabs
        value={tab}
        onValueChange={(value: InspectorTab) => {
          onTabChange(value);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mt-3 px-4">
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="inputs">Inputs</TabsTrigger>
          <TabsTrigger value="test">Test</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <TabsContent value="setup" keepMounted>
            <SetupTab
              node={node}
              definition={definition}
              connections={connections}
              workspaceId={workspaceId}
              form={form}
            />
          </TabsContent>
          <TabsContent value="inputs" keepMounted>
            <InputsTab
              node={node}
              graph={graph}
              definition={definition}
              definitions={definitions}
              form={form}
              onConnect={actions.onConnect}
              onRemoveEdge={actions.onRemoveEdge}
            />
          </TabsContent>
          <TabsContent value="test" keepMounted>
            {testPanel}
          </TabsContent>
          <TabsContent value="about" keepMounted>
            <AboutTab
              node={node}
              definition={definition}
              onCopyId={actions.onCopyId}
            />
          </TabsContent>
        </div>
      </Tabs>
      <InspectorFooter
        scratch={scratch}
        editable={editable}
        onDiscard={actions.onDiscardScratch}
      />
    </div>
  );
}

function InspectorFooter({
  scratch,
  editable,
  onDiscard,
}: Readonly<{ scratch: boolean; editable: boolean; onDiscard: () => void }>) {
  if (!editable) return null;
  return (
    <div
      role="status"
      className="flex min-h-11 items-center gap-2 border-t border-white/7 px-4 py-2 text-xs text-subtle-foreground"
    >
      {scratch ? (
        <>
          <TriangleAlertIcon
            aria-hidden="true"
            className="size-3.5 text-warning"
          />
          <span className="flex-1">
            An edit isn’t valid yet, so it isn’t saved.
          </span>
          <Button type="button" size="xs" variant="ghost" onClick={onDiscard}>
            Discard it
          </Button>
        </>
      ) : (
        <>
          <CheckIcon aria-hidden="true" className="size-3.5" />
          Changes save automatically · <Kbd>⌘Z</Kbd> to undo
        </>
      )}
    </div>
  );
}

function pulse(element: Element | null | undefined) {
  if (
    element === null ||
    element === undefined ||
    typeof element.animate !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return;
  element.animate(
    [
      {
        boxShadow:
          '0 0 0 0 color-mix(in srgb, var(--primary) 55%, transparent)',
      },
      {
        boxShadow:
          '0 0 0 10px color-mix(in srgb, var(--primary) 0%, transparent)',
      },
    ],
    { duration: 700, iterations: 2, easing: 'ease-out' },
  );
}
