import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { WorkflowImportRequest } from '@pertexo/contracts';
import { useCreateCommand } from '@/lib/api/commands/use-create-command';
import {
  RETRY_WINDOW_ENDED,
  isUnconfirmedCommand,
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
  const command = useCreateCommand({
    send: (body: WorkflowImportRequest, key) =>
      importWorkflow({
        apiClient,
        workspaceId,
        body,
        idempotencyKey: key,
        signal: new AbortController().signal,
      }),
    refresh: () =>
      Promise.all([
        cache.invalidateQueries({
          queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
        }),
        cache.invalidateQueries({
          queryKey: workflowKeys.scope(userId, workspaceId),
        }),
      ]),
  });

  /**
   * `name` replaces the example's own title when the person typed one.
   * Resolves to what went wrong, if anything; Try again sends the same
   * request, so a lost answer can't create a second copy.
   */
  async function start(
    template: CuratedTemplate,
    name = '',
  ): Promise<string | undefined> {
    if (starting !== undefined) return undefined;
    setStarting(template.templateId);
    const source = {
      manifest: template.manifest,
      bindings: [],
      templateOrigin: templateOrigin(template),
    };
    let creating = false;
    try {
      const preview = await previewWorkflowImport(
        apiClient,
        workspaceId,
        source,
        new AbortController().signal,
      );
      if (!preview.compatible || preview.connectionSlots.length > 0) {
        onNeedsReview(template);
        return undefined;
      }
      creating = true;
      const created = await command.create({
        ...source,
        name: name === '' ? template.title : name,
        expectedCompatibilityFingerprint: preview.compatibilityFingerprint,
      });
      if (created === undefined) {
        command.startNewAttempt();
        return RETRY_WINDOW_ENDED;
      }
      onCreated(created.workflowId, template);
      return undefined;
    } catch (cause) {
      // A lost answer to the create may have made the draft; the held key
      // makes the next identical send replay it instead.
      return creating && isUnconfirmedCommand(cause)
        ? 'We couldn’t confirm whether the example was created. Try again: it can’t make a second copy.'
        : describeCommandError(cause, 'starting this example');
    } finally {
      setStarting(undefined);
    }
  }

  return { starting, start };
}
