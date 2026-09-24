import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { authoringCatalogQueryOptions } from '@/features/catalog/public';
import { connectionDiscoveryQueryOptions } from '@/features/connections/public';
import {
  useWorkflowCommandSession,
  WorkflowActions,
} from '@/features/workflow-publish/public';
import type { WorkflowValidationTarget } from '@/features/workflow-publish/public';
import { workflowRunKeys } from '@/features/workflow-runs/queries.public';
import {
  workflowKeys,
  workflowSummaryQueryOptions,
} from '@/features/workflows/public';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { cn } from '@/lib/utils';
import {
  ConflictComparisonNotice,
  ConflictDialog,
  LeaveEditorDialog,
  UnappliedChangesDialog,
} from './components/editor-dialogs';
import { EditorCommandBar } from './components/chrome/editor-command-bar';
import {
  EditorPanelLayout,
  type EditorPanel,
} from './components/editor-panel-layout';
import { WorkflowCanvas } from './components/workflow-canvas';
import {
  WorkflowInspector,
  type WorkflowInspectorHandle,
} from './components/workflow-inspector';
import { NodePalette } from './components/palette/node-palette';
import { EditorProvider } from './model/editor-provider';
import {
  useEditorStore,
  useEditorStoreApi,
} from './model/editor-store-context';
import { addDefinitionNode, removeWorkflowNode } from './model/graph-adapter';
import type { SaveCoordinatorTransport } from './model/save-coordinator';
import { useSaveCoordinator } from './model/use-save-coordinator';
import { useEditorSessionVerification } from './model/use-editor-session-verification';
import { getWorkflowDraft, saveWorkflowDraft } from './workflow-editor.api';
import { workflowDraftQueryOptions } from './workflow-editor.queries';

export function WorkflowEditorPage({
  apiClient,
  user,
  workspace,
  workflowId,
  onBack,
  onRunAccepted,
  onOpenSettings,
  mobileNavigation,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
  onBack: () => void;
  onRunAccepted: (runId: string) => void;
  onOpenSettings: () => void;
  mobileNavigation?: ReactNode;
}>) {
  const draft = useSuspenseQuery(
    workflowDraftQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const catalog = useSuspenseQuery(
    authoringCatalogQueryOptions(apiClient, user.id),
  );
  const connections = useSuspenseQuery(
    connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
  );
  const workflow = useQuery(
    workflowSummaryQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  return (
    <EditorProvider
      key={`${user.id}:${workspace.id}:${workflowId}`}
      initial={{
        graph: draft.data.draft.graph,
        etag: draft.data.etag,
        revision: draft.data.draft.revision,
      }}
    >
      <WorkflowEditorSession
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        workflowId={workflowId}
        workflowName={workflow.data?.name}
        workflowNameUnavailable={workflow.isError}
        onRetryWorkflowName={() => void workflow.refetch()}
        definitions={catalog.data.definitions.items}
        connections={connections.data.items}
        onBack={onBack}
        onRunAccepted={onRunAccepted}
        onOpenSettings={onOpenSettings}
        mobileNavigation={mobileNavigation}
      />
    </EditorProvider>
  );
}

function WorkflowEditorSession({
  apiClient,
  userId,
  workspace,
  workflowId,
  workflowName,
  workflowNameUnavailable,
  onRetryWorkflowName,
  definitions,
  connections,
  onBack,
  onRunAccepted,
  onOpenSettings,
  mobileNavigation,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  workflowName: string | undefined;
  workflowNameUnavailable: boolean;
  onRetryWorkflowName: () => void;
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  onBack: () => void;
  onRunAccepted: (runId: string) => void;
  onOpenSettings: () => void;
  mobileNavigation?: ReactNode;
}>) {
  const store = useEditorStoreApi();
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const generation = useEditorStore((state) => state.generation);
  const revision = useEditorStore((state) => state.revision);
  const hasRetainedComparison = useEditorStore(
    (state) => state.conflict !== null && state.saveStatus !== 'conflict',
  );
  const transact = useEditorStore((state) => state.transact);
  const inspectorRef = useRef<WorkflowInspectorHandle>(null);
  const [scratchVersion, setScratchVersion] = useState(0);
  const [focusTarget, setFocusTarget] = useState<
    (WorkflowValidationTarget & Readonly<{ requestId: number }>) | undefined
  >();
  const [pendingAction, setPendingAction] = useState<PendingEditorAction>();
  const [smallScreenPanel, setSmallScreenPanel] =
    useState<EditorPanel>('canvas');
  const queryClient = useQueryClient();
  const canUpdate = workspace.capabilities.includes('workflow:update');
  const {
    pauseReason: effectiveSessionPause,
    verificationPending,
    verifyOwner,
    verifyOriginalAccount,
    isPaused,
  } = useEditorSessionVerification({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });

  const saveTransport = useMemo<SaveCoordinatorTransport>(
    () => ({
      save: async (nextGraph, etag, signal) => {
        await verifyOwner(signal);
        return saveWorkflowDraft(apiClient, workspace.id, workflowId, {
          graph: nextGraph,
          etag,
          signal,
        });
      },
      reload: (signal) =>
        getWorkflowDraft(apiClient, workspace.id, workflowId, signal),
      isConflict: (error) => isApiError(error) && error.status === 412,
      isUncertain: (error) =>
        isApiError(error) &&
        ['network', 'protocol', 'timeout'].includes(error.kind),
      message: editorSaveErrorMessage,
    }),
    [apiClient, verifyOwner, workflowId, workspace.id],
  );
  const flushSave = useSaveCoordinator(
    store,
    saveTransport,
    canUpdate && effectiveSessionPause === undefined,
  );
  const ensureSaved = useCallback(async () => {
    if (effectiveSessionPause !== undefined)
      throw new Error(
        'The editor is paused because its authenticated identity is no longer verified.',
      );
    if (inspectorRef.current?.isDirty())
      throw new Error(
        'Apply or discard the inspector changes before continuing.',
      );
    await verifyOwner();
    await flushSave();
    await verifyOwner();
    const state = store.getState();
    if (state.saveStatus !== 'clean')
      throw new Error(
        state.saveStatus === 'conflict'
          ? 'Resolve the draft conflict before continuing.'
          : 'The draft must be saved before continuing.',
      );
    return {
      etag: state.etag,
      generation: state.generation,
      revision: state.revision,
    } as const;
  }, [effectiveSessionPause, flushSave, store, verifyOwner]);
  const shouldBlock = useCallback(
    () =>
      inspectorRef.current?.isDirty() === true ||
      store.getState().saveStatus !== 'clean' ||
      hasRetainedComparison,
    [hasRetainedComparison, store],
  );
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: shouldBlock,
    withResolver: true,
  });
  const commandSession = useWorkflowCommandSession({
    apiClient,
    workspaceId: workspace.id,
    workflowId,
    verifyIdentity: verifyOwner,
    isSessionPaused: isPaused,
    ensureSaved,
    onRunAccepted,
    onRunCommandAccepted: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspace.id),
      });
    },
    onPublicationAccepted: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspace.id),
      });
    },
  });

  const performEditorAction = useCallback(
    (action: PendingEditorAction) => {
      if (action.kind === 'selection') {
        store.getState().selectNode(action.nodeId);
        if (action.focusTarget !== undefined) {
          const target = action.focusTarget;
          setFocusTarget((current) => ({
            ...target,
            requestId: (current?.requestId ?? 0) + 1,
          }));
          setSmallScreenPanel('inspector');
        }
      } else if (action.kind === 'undo') {
        store.getState().undo();
      } else if (action.kind === 'delete') {
        const state = store.getState();
        state.transact(removeWorkflowNode(state.graph, action.nodeId));
        state.selectNode(null);
      } else {
        store.getState().redo();
      }
    },
    [store],
  );
  const requestEditorAction = useCallback(
    (action: PendingEditorAction) => {
      if (isPaused()) return;
      if (
        action.kind === 'selection' &&
        action.nodeId === store.getState().selectedNodeId &&
        action.focusTarget === undefined
      )
        return;
      if (inspectorRef.current?.isDirty()) setPendingAction(action);
      else performEditorAction(action);
    },
    [isPaused, performEditorAction, store],
  );

  const onEditorKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (isPaused()) return;
    if (isEditableTarget(event.target)) return;
    const commandKey = event.metaKey || event.ctrlKey;
    if (commandKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      requestEditorAction({ kind: event.shiftKey ? 'redo' : 'undo' });
    } else if (commandKey && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      requestEditorAction({ kind: 'redo' });
    } else if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      selectedNodeId !== null &&
      canUpdate &&
      document.activeElement?.closest('[data-workflow-canvas]') !== null
    ) {
      event.preventDefault();
      requestEditorAction({ kind: 'delete', nodeId: selectedNodeId });
    }
  });
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      onEditorKeyDown(event);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const pauseNotice =
    effectiveSessionPause === undefined ? null : (
      <section className="grid h-full min-h-0 place-items-center bg-background p-6">
        <div className="max-w-lg rounded-xl border border-white/10 bg-card p-6">
          <h1 className="text-lg font-semibold">Editor paused</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {effectiveSessionPause === 'changed'
              ? 'The authenticated account changed while this workflow was open.'
              : 'Pertexo could not verify that the authenticated account still owns this editor session.'}{' '}
            Pending writes were canceled, and this draft will not be saved under
            another or unverified account. Return to the workspace and reopen
            the workflow after the session is available.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={verificationPending}
              onClick={() => {
                void verifyOriginalAccount();
              }}
            >
              {verificationPending ? 'Verifying…' : 'Verify original account'}
            </Button>
            <Button type="button" variant="outline" onClick={onBack}>
              Return to workspace
            </Button>
          </div>
        </div>
      </section>
    );

  function addNode(definition: NodeDefinitionCatalogItem) {
    const count = graph.nodes.length;
    transact(
      addDefinitionNode(graph, definition, {
        x: 120 + (count % 4) * 260,
        y: 100 + Math.floor(count / 4) * 160,
      }),
    );
  }

  return (
    <>
      {pauseNotice}
      <div
        className={cn(
          'h-full min-h-0 flex-col bg-background',
          effectiveSessionPause === undefined ? 'flex' : 'hidden',
        )}
        inert={effectiveSessionPause !== undefined}
        aria-hidden={effectiveSessionPause !== undefined}
      >
        <EditorCommandBar
          workflowId={workflowId}
          workflowName={workflowName}
          workflowNameUnavailable={workflowNameUnavailable}
          onRetryWorkflowName={onRetryWorkflowName}
          canUpdate={canUpdate}
          onBack={onBack}
          onSave={() => void flushSave()}
          onUndo={() => {
            requestEditorAction({ kind: 'undo' });
          }}
          onRedo={() => {
            requestEditorAction({ kind: 'redo' });
          }}
          onOpenSettings={onOpenSettings}
          navigation={mobileNavigation}
          actions={
            effectiveSessionPause === undefined ? (
              <WorkflowActions
                apiClient={apiClient}
                userId={userId}
                workspace={workspace}
                workflowId={workflowId}
                selectedNodeId={selectedNodeId}
                graph={graph}
                generation={generation}
                revision={revision}
                commandSession={commandSession}
                ensureSaved={ensureSaved}
                onValidationTarget={(target) => {
                  requestEditorAction({
                    kind: 'selection',
                    nodeId: target.nodeId,
                    focusTarget: target,
                  });
                }}
              />
            ) : null
          }
        />
        <ConflictComparisonNotice />
        <EditorPanelLayout
          canUpdate={canUpdate}
          current={smallScreenPanel}
          onSelect={setSmallScreenPanel}
          palette={<NodePalette definitions={definitions} onAdd={addNode} />}
          canvas={
            <WorkflowCanvas
              definitions={definitions}
              editable={canUpdate}
              onSelectionRequest={(nodeId) => {
                requestEditorAction({ kind: 'selection', nodeId });
              }}
              onDeleteRequest={(nodeId) => {
                requestEditorAction({ kind: 'delete', nodeId });
              }}
            />
          }
          inspector={
            <WorkflowInspector
              definitions={definitions}
              connections={connections}
              editable={canUpdate}
              actionRef={inspectorRef}
              scratchVersion={scratchVersion}
              {...(focusTarget === undefined ? {} : { focusTarget })}
            />
          }
        />
        {effectiveSessionPause === undefined ? <ConflictDialog /> : null}
        {effectiveSessionPause === undefined ? (
          <UnappliedChangesDialog
            open={pendingAction !== undefined}
            action={
              pendingAction?.kind === 'selection'
                ? 'selection'
                : pendingAction?.kind === 'delete'
                  ? 'delete'
                  : 'history'
            }
            onApply={() => {
              if (pendingAction === undefined) return;
              if (inspectorRef.current?.apply() !== true) return;
              const action = pendingAction;
              setPendingAction(undefined);
              if (action.kind === 'selection') performEditorAction(action);
            }}
            onDiscard={() => {
              if (pendingAction === undefined) return;
              const action = pendingAction;
              setPendingAction(undefined);
              setScratchVersion((current) => current + 1);
              performEditorAction(action);
            }}
            onStay={() => {
              setPendingAction(undefined);
            }}
          />
        ) : null}
      </div>
      <LeaveEditorDialog
        blocker={blocker}
        retainedComparison={hasRetainedComparison}
      />
    </>
  );
}

type PendingEditorAction =
  | Readonly<{
      kind: 'selection';
      nodeId: string | null;
      focusTarget?: WorkflowValidationTarget;
    }>
  | Readonly<{ kind: 'delete'; nodeId: string }>
  | Readonly<{ kind: 'undo' | 'redo' }>;

function editorSaveErrorMessage(error: unknown): string {
  if (!isApiError(error)) return 'The draft could not be saved.';
  if (error.kind === 'network' || error.kind === 'timeout')
    return 'The save result could not be confirmed. Your local graph is preserved.';
  if (error.status === 403)
    return 'You no longer have permission to update this workflow.';
  if (error.status === 422)
    return 'The graph is not valid for this workflow. Review the node configuration.';
  return 'The draft could not be saved. Your local graph is preserved.';
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
  );
}
