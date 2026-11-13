import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { WorkflowImportRequest } from '@pertexo/contracts';
import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/command-retry';
import { describeCommandError } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import {
  importWorkflow,
  previewWorkflowImport,
} from '../data/portability/workflow-portability.api';
import { workflowKeys } from '../data/workflows.queries';
import { workflowOrganizationKeys } from '../data/organization/workflow-organization.queries';
import {
  templateOrigin,
  type CuratedTemplate,
} from '../model/templates/curated-setup';

/** An example that starts in one click: nothing to fill in or connect. */
export function startsInOneClick(template: CuratedTemplate): boolean {
  return (
    template.setupTargets.length === 0 &&
    template.manifest.connectionSlots.length === 0
  );
}

/**
 * One example start the server may already have carried out: its exact
 * request and key. Home's "Try the example" and the workflow list both start
 * examples, so an unconfirmed start is held here, by account, workspace and
 * example, not in either one's component: starting the same example again
 * from anywhere resends it and can't make a second copy. Another account
 * never finds it.
 */
type HeldStart = Readonly<{ key: CommandKey; body: WorkflowImportRequest }>;
const heldStarts = new Map<string, HeldStart>();

/**
 * "Use this example" for an example with nothing to set up: checks it
 * against this workspace, creates its unpublished draft and hands over the
 * new workflow, with no import dialog. An example this workspace can't build
 * goes to `onNeedsReview`, where the full dialog explains why.
 */
export function useStartExample({
  apiClient,
  userId,
  workspaceId,
  onCreated,
  onNeedsReview,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  onCreated: (workflowId: string, template: CuratedTemplate) => void;
  onNeedsReview: (template: CuratedTemplate) => void;
}>) {
  const cache = useQueryClient();
  // The example being started, if any.
  const [starting, setStarting] = useState<string>();

  async function request(template: CuratedTemplate, name: string) {
    const source = {
      manifest: template.manifest,
      bindings: [],
      templateOrigin: templateOrigin(template),
    };
    const preview = await previewWorkflowImport(
      apiClient,
      workspaceId,
      source,
      new AbortController().signal,
    );
    if (!preview.compatible || preview.connectionSlots.length > 0)
      return undefined;
    return {
      ...source,
      name: name === '' ? template.title : name,
      expectedCompatibilityFingerprint: preview.compatibilityFingerprint,
    };
  }

  /**
   * `name` replaces the example's own title when the person typed one.
   * Resolves to what went wrong, if anything; Try again, or starting the
   * same example from elsewhere, resends the held request, so a lost answer
   * can't create a second copy.
   */
  async function start(
    template: CuratedTemplate,
    name = '',
  ): Promise<string | undefined> {
    if (starting !== undefined) return undefined;
    const intent = `${userId}:${workspaceId}:${template.templateId}`;
    let held = heldStarts.get(intent);
    if (held !== undefined && !canResend(held.key)) {
      heldStarts.delete(intent);
      return RETRY_WINDOW_ENDED;
    }
    setStarting(template.templateId);
    try {
      if (held === undefined) {
        const body = await request(template, name);
        if (body === undefined) {
          onNeedsReview(template);
          return undefined;
        }
        held = { key: newCommandKey(), body };
        heldStarts.set(intent, held);
      }
      const created = await importWorkflow({
        apiClient,
        workspaceId,
        body: held.body,
        idempotencyKey: held.key.idempotencyKey,
        signal: new AbortController().signal,
      });
      heldStarts.delete(intent);
      onCreated(created.workflowId, template);
      return undefined;
    } catch (cause) {
      // A lost answer to the create may have made the draft; anything
      // definite lets the next start be a new one.
      if (held !== undefined && isUnconfirmedCommand(cause))
        return 'We couldn’t confirm whether the example was created. Try again: it can’t make a second copy.';
      heldStarts.delete(intent);
      return describeCommandError(cause, 'starting this example');
    } finally {
      setStarting(undefined);
      void Promise.allSettled([
        cache.invalidateQueries({
          queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
        }),
        cache.invalidateQueries({
          queryKey: workflowKeys.scope(userId, workspaceId),
        }),
      ]);
    }
  }

  return { starting, start };
}
