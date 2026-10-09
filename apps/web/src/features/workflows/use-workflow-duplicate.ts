import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowDuplicateRequest } from '@pertexo/contracts';
import { subscribeSessionChanges } from '@/features/auth/session-sync.public';
import { describeCommandError } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import {
  duplicateWorkflow,
  getWorkflowDuplicateDraft,
  type WorkflowDuplicateAttempt,
} from './workflows.api';
import { workflowKeys } from './workflows.queries';
import { workflowOrganizationKeys } from './organization.queries';
import {
  duplicateFailureState,
  type DuplicatePhase,
  type DuplicateState,
} from './model/workflow-duplicate-state';
import {
  isDuplicateAccessLoss,
  observeDuplicateAccessLoss,
  verifyDuplicateAuthority,
} from './workflow-duplicate-authority';

type DuplicateAttempt = WorkflowDuplicateAttempt & {
  result?: Readonly<{ workflowId: string }>;
};

type WorkflowDuplicateOptions = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  source: WorkflowDuplicateRequest['source'];
  allowed: boolean;
  onCreated: (workflowId: string) => void;
  onAccessLost: () => void;
}>;

/** One ephemeral, exact command; no mutation cache/offline replay or client graph. */
export function useWorkflowDuplicate({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  source,
  allowed,
  onCreated,
  onAccessLost,
}: WorkflowDuplicateOptions) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<DuplicateState>({ kind: 'loading' });
  const owner = useRef<symbol | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const attempt = useRef<DuplicateAttempt | undefined>(undefined);
  const busy = useRef(false);
  const kind = source.kind;
  const versionId = source.kind === 'version' ? source.versionId : undefined;

  const retire = useCallback(() => {
    owner.current = undefined;
    request.current?.abort();
    attempt.current = undefined;
    onAccessLost();
    setState({
      kind: 'denied',
      error:
        'Access changed. Close this dialog and reopen it after checking your account and workspace.',
    });
    const scope = ['identity', userId, 'workspace', workspaceId];
    void queryClient.cancelQueries({ queryKey: scope });
    queryClient.removeQueries({ queryKey: scope });
  }, [queryClient, userId, workspaceId, onAccessLost]);

  const verify = useCallback(
    async (signal: AbortSignal) => {
      if (
        !(await verifyDuplicateAuthority(
          apiClient,
          userId,
          workspaceId,
          signal,
        ))
      ) {
        retire();
        return false;
      }
      return true;
    },
    [apiClient, userId, workspaceId, retire],
  );

  const loadDraft = useCallback(
    async (token: symbol) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setState({ kind: 'loading' });
      try {
        if (!(await verify(controller.signal)) || owner.current !== token)
          return;
        const draft = await getWorkflowDuplicateDraft(
          apiClient,
          workspaceId,
          workflowId,
          controller.signal,
        );
        if (owner.current === token && request.current === controller)
          setState({ kind: 'ready', draft });
      } catch (error) {
        if (owner.current !== token || request.current !== controller) return;
        if (isDuplicateAccessLoss(error)) retire();
        else
          setState({
            kind: 'failed',
            error: describeCommandError(error, 'reading the saved source'),
          });
      }
    },
    [apiClient, workspaceId, workflowId, verify, retire],
  );

  useEffect(() => {
    const token = Symbol('workflow-duplicate');
    owner.current = token;
    attempt.current = undefined;
    queueMicrotask(() => {
      if (owner.current !== token) return;
      if (!allowed) retire();
      else if (kind === 'draft') void loadDraft(token);
      else setState({ kind: 'ready' });
    });
    const unsubscribe = subscribeSessionChanges(retire);
    const unsubscribeCache = observeDuplicateAccessLoss(
      queryClient,
      userId,
      workspaceId,
      workflowId,
      () => owner.current === token,
      retire,
    );
    return () => {
      unsubscribe();
      unsubscribeCache();
      if (owner.current === token) owner.current = undefined;
      request.current?.abort();
      attempt.current = undefined;
    };
  }, [
    apiClient,
    userId,
    workspaceId,
    workflowId,
    kind,
    versionId,
    allowed,
    loadDraft,
    retire,
    queryClient,
  ]);

  async function send(command: DuplicateAttempt) {
    const token = owner.current;
    if (busy.current || token === undefined || !allowed) return;
    busy.current = true;
    const controller = new AbortController();
    request.current = controller;
    setState((current) => ({ ...current, kind: 'sending', error: undefined }));
    let phase: DuplicatePhase =
      command.result === undefined ? 'authority' : 'accepted';
    try {
      if (!(await verify(controller.signal)) || owner.current !== token) return;
      phase = command.result === undefined ? 'mutation' : 'accepted';
      const result =
        command.result ??
        (await duplicateWorkflow(
          apiClient,
          workspaceId,
          workflowId,
          command,
          controller.signal,
        ));
      command.result = result;
      phase = 'accepted';
      if (
        owner.current !== token ||
        !(await verify(controller.signal)) ||
        owner.current !== token
      )
        return;
      attempt.current = undefined;
      void queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      });
      setState({ kind: 'ready' });
      onCreated(result.workflowId);
    } catch (error) {
      if (owner.current !== token) return;
      if (isDuplicateAccessLoss(error)) {
        retire();
        return;
      }
      const next = duplicateFailureState(error, state, phase);
      attempt.current = next.kind === 'uncertain' ? command : undefined;
      setState(next);
    } finally {
      busy.current = false;
    }
  }

  return {
    state,
    refresh: () => {
      const token = owner.current;
      if (token !== undefined && !busy.current && state.kind !== 'uncertain')
        void loadDraft(token);
    },
    start: (name: string) => {
      if (state.kind !== 'ready') return;
      const command: DuplicateAttempt = {
        body: { name, source },
        idempotencyKey: crypto.randomUUID(),
        ...(state.draft === undefined ? {} : { etag: state.draft.etag }),
      };
      attempt.current = command;
      void send(command);
    },
    retry: () => {
      if (state.kind === 'uncertain' && attempt.current !== undefined)
        void send(attempt.current);
    },
  };
}
