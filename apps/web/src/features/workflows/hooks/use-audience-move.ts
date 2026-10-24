import { useEffect, useRef, useState } from 'react';
import type {
  WorkflowMoveReview,
  WorkflowMoveReviewRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { describeCommandError } from '@/lib/api/error-copy';
import { reviewWorkflowMove } from '../data/organization/sharing.api';
import {
  freezeWorkflowOrganizationAttempt,
  type WorkflowOrganizationAttempt,
} from '../model/organization/requests';
function requestFor(
  attempt: WorkflowOrganizationAttempt,
): WorkflowMoveReviewRequest | undefined {
  switch (attempt.kind) {
    case 'move-folder':
      return {
        kind: 'folder',
        folderId: attempt.folderId,
        destinationFolderId: attempt.body.parentId,
      };
    case 'place-folder':
      return {
        kind: 'workflows',
        workflowIds: [attempt.workflowId],
        destinationFolderId: attempt.body.folderId,
      };
    case 'bulk':
      return attempt.body.operation === 'move'
        ? {
            kind: 'workflows',
            workflowIds: attempt.body.items.map((item) => item.workflowId),
            destinationFolderId: attempt.body.folderId,
          }
        : undefined;
    case 'create-folder':
    case 'create-tag':
    case 'delete-folder':
    case 'delete-tag':
    case 'rename-folder':
    case 'rename-tag':
    case 'replace-tags':
    case 'tag-cleanup':
    default:
      return undefined;
  }
}
function acknowledged(
  attempt: WorkflowOrganizationAttempt,
  review: WorkflowMoveReview,
): WorkflowOrganizationAttempt {
  const forId = (id: string) => {
    const item = review.items.find(
      (item) => item.id === id && item.requiresReview,
    );
    return item
      ? { audienceReview: { token: item.token, acknowledge: true as const } }
      : {};
  };
  if (attempt.kind === 'move-folder')
    return {
      ...attempt,
      body: { ...attempt.body, ...forId(attempt.folderId) },
    };
  if (attempt.kind === 'place-folder')
    return {
      ...attempt,
      body: { ...attempt.body, ...forId(attempt.workflowId) },
    };
  if (attempt.kind === 'bulk' && attempt.body.operation === 'move')
    return {
      ...attempt,
      body: {
        ...attempt.body,
        items: attempt.body.items.map((item) => ({
          ...item,
          ...forId(item.workflowId),
        })),
      },
    };
  return attempt;
}
/** A review binds one exact proposed move; the server still checks it in the move transaction. */
export function useAudienceMove(
  api: ApiClient,
  workspaceId: string,
  send: (attempt: WorkflowOrganizationAttempt) => void | Promise<void>,
) {
  const [review, setReview] = useState<
    Readonly<{
      attempt: WorkflowOrganizationAttempt;
      report: WorkflowMoveReview;
    }>
  >();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, [api, workspaceId]);
  const begin = async (input: WorkflowOrganizationAttempt) => {
    if (request.current || review) return;
    const attempt = freezeWorkflowOrganizationAttempt(input);
    const body = requestFor(attempt);
    if (!body) {
      await send(attempt);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(undefined);
    try {
      const report = await reviewWorkflowMove(
        api,
        workspaceId,
        body,
        controller.signal,
      );
      if (!alive.current || controller.signal.aborted) return;
      if (report.items.some((item) => item.requiresReview))
        setReview({ attempt, report });
      else await send(attempt);
    } catch (cause) {
      if (alive.current && !controller.signal.aborted)
        setError(describeCommandError(cause, 'reviewing this move'));
    } finally {
      if (request.current === controller) request.current = undefined;
      if (alive.current) setPending(false);
    }
  };
  return {
    begin,
    pending,
    review,
    error,
    cancel: () => {
      setReview(undefined);
      setError(undefined);
    },
    confirm: async () => {
      if (!review || pending) return;
      const attempt = acknowledged(review.attempt, review.report);
      setReview(undefined);
      await send(attempt);
    },
  };
}
