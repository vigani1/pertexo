import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { subscribeSessionChanges } from '@/features/auth/session/sync.public';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { RETRY_WINDOW_ENDED, canResend } from '@/lib/api/commands/contract';
import {
  freezeWorkflowOrganizationAttempt,
  type WorkflowOrganizationAttempt,
} from '../model/organization/requests';
import { sendWorkflowOrganizationCommand } from '../data/organization/api';
import { workflowOrganizationKeys } from '../data/organization/queries';
import { workflowKeys } from '../data/workflows.queries';
import type { RequiredRole } from '../data/organization/authority';
import { allowed } from '../data/organization/authority';
import { accessLost } from '../data/organization/authority';
import { clearOrganizationQueries } from '../data/organization/authority';
import { verifyCurrentAuthority } from '../data/organization/authority';
import { observeAuthority } from '../data/organization/authority';

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

/** A sent command and when it was first sent, for an exact retry. */
type Held = Readonly<{
  command: WorkflowOrganizationAttempt;
  createdAt: number;
}>;

const idle: State = { pending: false, retryAvailable: false, denied: false };

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
  const attempt = useRef<Held | undefined>(undefined);
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
    const unsubscribeCache = observeAuthority({
      queryClient,
      userId,
      workspaceId,
      requiredRole,
      current: () => owner.current === token,
      retire,
    });
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

  const send = (held: Held) =>
    sendOrganizationCommand(
      {
        apiClient,
        userId,
        workspaceId,
        requiredRole,
        queryClient,
        owner,
        request,
        attempt,
        denied,
        currentAllowed,
        retire,
        setState,
      },
      held,
    );

  return {
    ...state,
    start: async (input) => {
      const organizationRetryBlocked =
        request.current !== undefined ||
        attempt.current !== undefined ||
        denied.current ||
        !currentAllowed ||
        owner.current === undefined;
      if (organizationRetryBlocked) return;
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
      const held = { command: frozen, createdAt: Date.now() };
      attempt.current = held;
      await send(held);
    },
    retry: async () => {
      const held = attempt.current;
      if (held === undefined) return;
      if (canResend(held)) await send(held);
      else {
        attempt.current = undefined;
        setState({ ...idle, error: RETRY_WINDOW_ENDED });
      }
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

type OrganizationCommandContext = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  requiredRole: RequiredRole;
  queryClient: QueryClient;
  owner: RefObject<symbol | undefined>;
  request: RefObject<AbortController | undefined>;
  attempt: RefObject<Held | undefined>;
  denied: RefObject<boolean>;
  currentAllowed: boolean;
  retire: () => void;
  setState: Dispatch<SetStateAction<State>>;
}>;
async function sendOrganizationCommand(
  {
    apiClient,
    userId,
    workspaceId,
    requiredRole,
    queryClient,
    owner,
    request,
    attempt,
    denied,
    currentAllowed,
    retire,
    setState,
  }: OrganizationCommandContext,
  held: Held,
) {
  const token = owner.current;
  const organizationRequestBlocked =
    token === undefined ||
    request.current !== undefined ||
    denied.current ||
    !currentAllowed;
  if (organizationRequestBlocked) return;
  const controller = new AbortController();
  request.current = controller;
  const current = () =>
    owner.current === token &&
    request.current === controller &&
    !controller.signal.aborted;
  const verify = () =>
    verifyCurrentAuthority({
      apiClient,
      userId,
      workspaceId,
      requiredRole,
      signal: controller.signal,
      current,
      retire,
    });
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
      held.command,
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
    attempt.current = retryAvailable ? held : undefined;
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
    attempt.current = retryAvailable ? held : undefined;
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
