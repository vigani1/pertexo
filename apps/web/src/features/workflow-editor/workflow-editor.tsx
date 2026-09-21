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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { authoringCatalogQueryOptions } from '@/features/catalog/public';
import { connectionDiscoveryQueryOptions } from '@/features/connections/public';
import {
  assertSessionIdentity,
  currentUserQueryOptions,
  isSessionIdentityChangedError,
  isSessionIdentityUnverifiedError,
} from '@/features/auth/public';
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
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
  onBack: () => void;
  onRunAccepted: (runId: string) => void;
  onOpenSettings: () => void;
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
  const [formDirty, setFormDirty] = useState(false);
  const inspectorRef = useRef<WorkflowInspectorHandle>(null);
  const [scratchVersion, setScratchVersion] = useState(0);
  const [focusTarget, setFocusTarget] = useState<
    (WorkflowValidationTarget & Readonly<{ requestId: number }>) | undefined
  >();
  const [pendingAction, setPendingAction] = useState<PendingEditorAction>();
  const [smallScreenPanel, setSmallScreenPanel] =
    useState<EditorPanel>('canvas');
  const [sessionPause, setSessionPause] = useState<
    'changed' | 'unverified' | undefined
  >();
  const [verificationPending, setVerificationPending] = useState(false);
  const sessionLifecycle = useRef({ paused: false });
  const verificationOwner = useRef<symbol | undefined>(undefined);
  const verificationAbort = useRef<AbortController | undefined>(undefined);
  const queryClient = useQueryClient();
  const currentUser = useQuery(currentUserQueryOptions(apiClient));
  const canUpdate = workspace.capabilities.includes('workflow:update');
  const pauseSession = useCallback((reason: 'changed' | 'unverified') => {
    sessionLifecycle.current.paused = true;
    setSessionPause(reason);
  }, []);
  const verifyOwner = useCallback(
    async (signal?: AbortSignal) => {
      try {
        await assertSessionIdentity(apiClient, userId, signal);
      } catch (error) {
        if (
          isSessionIdentityChangedError(error) ||
          (isApiError(error) && error.status === 401)
        )
          pauseSession('changed');
        else if (isSessionIdentityUnverifiedError(error))
          pauseSession('unverified');
        throw error;
      }
    },
    [apiClient, pauseSession, userId],
  );

  const observedIdentityChanged =
    (currentUser.data !== undefined && currentUser.data.id !== userId) ||
    (isApiError(currentUser.error) && currentUser.error.status === 401);
  const effectiveSessionPause =
    sessionPause ?? (observedIdentityChanged ? 'changed' : undefined);

  useLayoutEffect(() => {
    const lifecycle = sessionLifecycle.current;
    lifecycle.paused = effectiveSessionPause !== undefined;
    return () => {
      lifecycle.paused = true;
    };
  }, [effectiveSessionPause]);

  useEffect(() => {
    const owner = Symbol('editor-session-verification');
    verificationOwner.current = owner;
    return () => {
      if (verificationOwner.current === owner) {
        verificationOwner.current = undefined;
        verificationAbort.current?.abort();
        verificationAbort.current = undefined;
      }
    };
  }, [apiClient, userId, workflowId, workspace.id]);

  const verifyOriginalAccount = useCallback(async () => {
    if (verificationAbort.current !== undefined) return;
    const owner = verificationOwner.current;
    if (owner === undefined) return;
    const controller = new AbortController();
    verificationAbort.current = controller;
    setVerificationPending(true);
    try {
      const verifiedUser = await assertSessionIdentity(
        apiClient,
        userId,
        controller.signal,
      );
      if (
        verificationOwner.current !== owner ||
        verificationAbort.current !== controller
      )
        return;
      queryClient.setQueryData(
        currentUserQueryOptions(apiClient).queryKey,
        verifiedUser,
      );
      sessionLifecycle.current.paused = false;
      setSessionPause(undefined);
    } catch (error) {
      if (
        verificationOwner.current !== owner ||
        verificationAbort.current !== controller
      )
        return;
      if (isApiError(error) && error.kind === 'canceled') return;
      pauseSession(
        isSessionIdentityChangedError(error) ||
          (isApiError(error) && error.status === 401)
          ? 'changed'
          : 'unverified',
      );
    } finally {
      if (
        verificationOwner.current === owner &&
        verificationAbort.current === controller
      ) {
        verificationAbort.current = undefined;
        setVerificationPending(false);
      }
    }
  }, [apiClient, pauseSession, queryClient, userId]);

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
    if (formDirty)
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
  }, [effectiveSessionPause, flushSave, formDirty, store, verifyOwner]);
  const shouldBlock = useCallback(
    () =>
      formDirty ||
      store.getState().saveStatus !== 'clean' ||
      hasRetainedComparison,
    [formDirty, hasRetainedComparison, store],
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
    isSessionPaused: () => sessionLifecycle.current.paused,
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
      if (
        action.kind === 'selection' &&
        action.nodeId === store.getState().selectedNodeId &&
        action.focusTarget === undefined
      )
        return;
      if (formDirty) setPendingAction(action);
      else performEditorAction(action);
    },
    [formDirty, performEditorAction, store],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
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
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [canUpdate, requestEditorAction, selectedNodeId, store, transact]);

  if (effectiveSessionPause !== undefined) {
    return (
      <section className="grid h-full min-h-0 place-items-center bg-background p-6">
        <div className="max-w-lg rounded-xl border border-white/10 bg-card p-6 shadow-xl">
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
  }

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
    <div className="flex h-full min-h-0 flex-col bg-background">
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
        actions={
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
        }
      />
      <ConflictComparisonNotice />
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
            current={smallScreenPanel}
            onSelect={setSmallScreenPanel}
          >
            Nodes
          </EditorPanelButton>
        ) : null}
        <EditorPanelButton
          panel="canvas"
          current={smallScreenPanel}
          onSelect={setSmallScreenPanel}
        >
          Canvas
        </EditorPanelButton>
        <EditorPanelButton
          panel="inspector"
          current={smallScreenPanel}
          onSelect={setSmallScreenPanel}
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
              smallScreenPanel === 'palette' ? 'block' : 'hidden',
              'xl:block',
            )}
          >
            <NodePalette definitions={definitions} onAdd={addNode} />
          </div>
        ) : null}
        <div
          id="editor-panel-canvas"
          role="region"
          aria-label="Workflow canvas"
          className={cn(
            'min-h-0 min-w-0',
            smallScreenPanel === 'canvas' ? 'block' : 'hidden',
            'xl:block',
          )}
        >
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
        </div>
        <div
          id="editor-panel-inspector"
          role="region"
          aria-label="Node inspector"
          className={cn(
            'min-h-0 [&>aside]:h-full',
            smallScreenPanel === 'inspector' ? 'block' : 'hidden',
            'xl:block',
          )}
        >
          <WorkflowInspector
            definitions={definitions}
            connections={connections}
            editable={canUpdate}
            onFormDirtyChange={setFormDirty}
            actionRef={inspectorRef}
            scratchVersion={scratchVersion}
            {...(focusTarget === undefined ? {} : { focusTarget })}
          />
        </div>
      </div>
      <ConflictDialog />
      <LeaveEditorDialog
        blocker={blocker}
        retainedComparison={hasRetainedComparison}
      />
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
    </div>
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

type EditorPanel = 'palette' | 'canvas' | 'inspector';

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
      variant={selected ? 'solid' : 'ghost'}
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
