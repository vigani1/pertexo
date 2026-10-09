import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  accessibleWorkspaceSchema,
  type AccessibleWorkspace,
} from '@pertexo/contracts';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
} from '@/features/auth/session-identity.public';
import { subscribeSessionChanges } from '@/features/auth/session-sync.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import {
  freezeWorkflowOrganizationAttempt,
  type WorkflowOrganizationAttempt,
} from '../model/organization/requests';
import { sendWorkflowOrganizationCommand } from '../data/organization.api';
import { workflowOrganizationKeys } from '../data/organization.queries';
import { workflowKeys } from '../data/workflows.queries';

type RequiredRole = 'member' | 'editor' | 'admin';
export type WorkflowOrganizationCommandResult = Awaited<
  ReturnType<typeof sendWorkflowOrganizationCommand>
>;
type State = Readonly<{
  pending: boolean;
  retryAvailable: boolean;
  denied: boolean;
  error?: string | undefined;
  result?: WorkflowOrganizationCommandResult;
}>;
export type WorkflowOrganizationCommandOptions = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  requiredRole: RequiredRole;
}>;
export type WorkflowOrganizationCommand = State &
  Readonly<{
    start: (attempt: WorkflowOrganizationAttempt) => Promise<void>;
    retry: () => Promise<void>;
    reset: () => void;
  }>;
const idle: State = { pending: false, retryAvailable: false, denied: false };

function allowed(
  workspace: AccessibleWorkspace | undefined,
  role: RequiredRole,
) {
  return (
    workspace?.status === 'active' &&
    workspace.capabilities.includes('workflow:read') &&
    (role === 'member' ||
      workspace.role === 'owner' ||
      workspace.role === 'admin' ||
      (role === 'editor' && workspace.role === 'builder'))
  );
}
function accessLost(error: unknown) {
  return (
    isSessionIdentityChangedError(error) ||
    (isApiError(error) && [401, 403, 404].includes(error.status ?? 0))
  );
}
function uncertain(error: unknown) {
  return (
    !isApiError(error) ||
    error.kind === 'network' ||
    error.kind === 'timeout' ||
    error.kind === 'protocol' ||
    (error.status ?? 0) >= 500
  );
}

/** Ephemeral exact command ownership; receipts are feedback, never current state. */
export function useWorkflowOrganizationCommand({
  apiClient,
  userId,
  workspace,
  requiredRole,
}: WorkflowOrganizationCommandOptions): WorkflowOrganizationCommand {
  const queryClient = useQueryClient();
  const [state, setState] = useState<State>(idle);
  const owner = useRef<symbol | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const attempt = useRef<WorkflowOrganizationAttempt | undefined>(undefined);
  const denied = useRef(false);
  const workspaceId = workspace.id;
  const currentAllowed = allowed(workspace, requiredRole);

  const retire = useCallback(() => {
    owner.current = undefined;
    request.current?.abort();
    request.current = undefined;
    attempt.current = undefined;
    denied.current = true;
    clearOrganizationQueries(queryClient, userId, workspaceId);
    setState({
      pending: false,
      retryAvailable: false,
      denied: true,
      error:
        'Access changed. Reopen this control after checking your account and workspace.',
    });
  }, [queryClient, userId, workspaceId]);

  useEffect(() => {
    const token = Symbol('organization-command');
    owner.current = token;
    denied.current = false;
    attempt.current = undefined;
    queueMicrotask(() => {
      if (owner.current !== token) return;
      if (!currentAllowed) retire();
      else if (request.current === undefined) setState(idle);
    });
    const unsubscribeSession = subscribeSessionChanges(retire);
    const unsubscribeCache = observeAuthority(
      queryClient,
      userId,
      workspaceId,
      requiredRole,
      () => owner.current === token,
      retire,
    );
    return () => {
      unsubscribeSession();
      unsubscribeCache();
      if (owner.current === token) owner.current = undefined;
      request.current?.abort();
      request.current = undefined;
      attempt.current = undefined;
    };
  }, [
    apiClient,
    userId,
    workspaceId,
    workspace.role,
    workspace.status,
    requiredRole,
    currentAllowed,
    queryClient,
    retire,
  ]);

  async function send(frozen: WorkflowOrganizationAttempt) {
    const token = owner.current;
    if (
      token === undefined ||
      request.current !== undefined ||
      denied.current ||
      !currentAllowed
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    const current = () =>
      owner.current === token &&
      request.current === controller &&
      !controller.signal.aborted;
    const verify = () =>
      verifyCurrentAuthority(
        apiClient,
        userId,
        workspaceId,
        requiredRole,
        controller.signal,
        current,
        retire,
      );
    setState((previous) => ({
      ...previous,
      pending: true,
      retryAvailable: false,
      error: undefined,
    }));
    try {
      if (!(await verify())) return;
      const result = await sendWorkflowOrganizationCommand(
        apiClient,
        frozen,
        controller.signal,
      );
      if (!current() || !(await verify()) || !current()) return;
      const authorityLost =
        'items' in result &&
        result.items.some((item) => item.status === 'forbidden');
      const retryAvailable =
        'items' in result &&
        !authorityLost &&
        result.items.some((item) => item.status === 'outcome_unknown');
      attempt.current = retryAvailable ? frozen : undefined;
      denied.current = authorityLost;
      if (authorityLost)
        clearOrganizationQueries(queryClient, userId, workspaceId);
      setState({
        pending: false,
        retryAvailable,
        denied: authorityLost,
        result,
      });
      void queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      });
    } catch (error) {
      if (!current()) return;
      if (accessLost(error)) {
        retire();
        return;
      }
      const retryAvailable = uncertain(error);
      attempt.current = retryAvailable ? frozen : undefined;
      setState({
        pending: false,
        retryAvailable,
        denied: false,
        error: retryAvailable
          ? 'The outcome could not be confirmed. Retry this exact command; refreshing current state preserves its recovery identity.'
          : definitiveMessage(error),
      });
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }

  return {
    ...state,
    start: async (input) => {
      if (
        request.current !== undefined ||
        attempt.current !== undefined ||
        denied.current ||
        !currentAllowed ||
        owner.current === undefined
      )
        return;
      if (input.workspaceId !== workspaceId) {
        setState({
          ...idle,
          error: 'The command belongs to a different workspace.',
        });
        return;
      }
      let frozen: WorkflowOrganizationAttempt;
      try {
        frozen = freezeWorkflowOrganizationAttempt(input);
      } catch {
        setState({ ...idle, error: 'The organization command is invalid.' });
        return;
      }
      attempt.current = frozen;
      await send(frozen);
    },
    retry: async () => {
      if (attempt.current !== undefined) await send(attempt.current);
    },
    reset: () => {
      // A reread is not evidence that an outstanding command did not commit.
      // Only a definitive result may release this owner's frozen intent.
      if (request.current !== undefined || attempt.current !== undefined)
        return;
      if (denied.current) retire();
      else setState(idle);
    },
  };
}

function clearOrganizationQueries(
  queryClient: QueryClient,
  userId: string,
  workspaceId: string,
) {
  const queryKey = workflowOrganizationKeys.scope(userId, workspaceId);
  void queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey });
}

async function verifyCurrentAuthority(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  requiredRole: RequiredRole,
  signal: AbortSignal,
  current: () => boolean,
  retire: () => void,
) {
  await assertSessionIdentity(apiClient, userId, signal);
  if (!current()) return false;
  const accessible = await getAllAccessibleWorkspaces(apiClient, signal);
  if (!current()) return false;
  if (
    !allowed(
      accessible.find((item) => item.id === workspaceId),
      requiredRole,
    )
  ) {
    retire();
    return false;
  }
  return true;
}

function observeAuthority(
  queryClient: QueryClient,
  userId: string,
  workspaceId: string,
  requiredRole: RequiredRole,
  current: () => boolean,
  retire: () => void,
) {
  return queryClient.getQueryCache().subscribe((event) => {
    if (!current() || event.type !== 'updated') return;
    const key = event.query.queryKey as readonly unknown[];
    const inScope =
      key[0] === 'identity' &&
      key[1] === userId &&
      key[2] === 'workspace' &&
      key[3] === workspaceId;
    const relatedRead =
      inScope && (key[4] === 'workflows' || key[4] === 'workflow-organization');
    const discovery =
      key[0] === 'identity' &&
      key[1] === userId &&
      key[2] === 'accessible-workspaces';
    const identity = key[0] === 'identity' && key[1] === 'current-user';
    // An earlier scoped observer may synchronously cancel/remove this query.
    // Preserve the event's immutable failure instead of its reverted state.
    const failure: unknown =
      event.action.type === 'error'
        ? event.action.error
        : event.query.state.error;
    if ((relatedRead || discovery || identity) && accessLost(failure)) retire();
    else if (inScope && isApiError(failure) && failure.status === 401) retire();
    if (discovery && event.query.state.status === 'success') {
      const parsed = accessibleWorkspaceSchema
        .array()
        .safeParse(event.query.state.data);
      if (
        parsed.success &&
        !allowed(
          parsed.data.find((item) => item.id === workspaceId),
          requiredRole,
        )
      )
        retire();
    }
    const data: unknown = event.query.state.data;
    if (
      identity &&
      typeof data === 'object' &&
      data !== null &&
      'id' in data &&
      typeof data.id === 'string' &&
      data.id !== userId
    )
      retire();
  });
}

function definitiveMessage(error: unknown) {
  const messages: Readonly<Record<string, string>> = {
    'workflow.folder_name_conflict':
      'Another folder in this parent already has that name.',
    'workflow.folder_limit_exceeded':
      'The workspace folder limit has been reached.',
    'workflow.folder_revision_conflict':
      'This folder changed. Refresh it before trying again.',
    'workflow.folder_hierarchy_conflict':
      'This move would create a cycle or exceed the folder depth limit.',
    'workflow.folder_not_empty':
      'Move the workflows and child folders out before deleting this folder.',
    'workflow.folder_not_visible':
      'This folder is no longer visible. Refresh the workspace.',
    'workflow.tag_delete_overflow':
      'This tag has too many assignments to delete at once. Use bounded cleanup first.',
    'workflow.tag_key_conflict': 'Another workspace tag already has that key.',
    'workflow.tag_limit_exceeded': 'The workspace tag limit has been reached.',
    'workflow.tag_revision_conflict':
      'This tag changed. Refresh it before trying again.',
    'workflow.organization_revision_conflict':
      'Workflow organization changed. Refresh it before trying again.',
    'request.idempotency_conflict':
      'This command key was already used for different input. Discard it and refresh before starting a new command.',
  };
  const code = isApiError(error) ? error.problem?.code : undefined;
  return code !== undefined && Object.hasOwn(messages, code)
    ? (messages[code] ?? 'The command was not accepted.')
    : 'The command was not accepted. Refresh current metadata before starting a new command.';
}
