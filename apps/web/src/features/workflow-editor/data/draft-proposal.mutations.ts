import {
  draftProposalDisclosureSchema,
  draftProposalResultSchema,
  type DraftProposalResult,
} from '@pertexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserFacingError } from '@/lib/api/error';
import { reconcileQuerySnapshot } from '@/lib/api/query-snapshot';
import { useEditorSession, useEditorStoreApi } from '../model/state/context';
import { saveWorkflowDraft } from './workflow-editor.api';
import { workflowDraftKeys } from './workflow-editor.queries';

export function useDraftProposal() {
  const { scope, editing } = useEditorSession();
  const { apiClient, workspace, workflowId, userId } = scope;
  const { ensureSaved, verifyIdentity } = editing;
  const queryClient = useQueryClient();
  const store = useEditorStoreApi();
  const path =
    `/v1/workspaces/${encodeURIComponent(workspace.id)}/workflows/${encodeURIComponent(workflowId)}/draft/proposal` as const;
  const disclosure = useMutation({
    mutationFn: async () => {
      await ensureSaved();
      return apiClient.request({
        path,
        response: {
          kind: 'json',
          decode: (value) => draftProposalDisclosureSchema.parse(value),
        },
      });
    },
  });
  const proposal = useMutation({
    mutationFn: async (body: { request: string; confirmation: string }) => {
      await verifyIdentity();
      return apiClient.request({
        path,
        method: 'POST',
        body,
        response: {
          kind: 'json',
          decode: (value) => draftProposalResultSchema.parse(value),
        },
      });
    },
  });
  const apply = useMutation({
    mutationFn: async (
      reviewed: Extract<DraftProposalResult, { kind: 'inspected' }>,
    ) => {
      await verifyIdentity();
      const before = store.getState();
      if (before.save.status !== 'clean' || before.inspectorScratch)
        throw new UserFacingError(
          'Finish your current edit before applying the proposal.',
        );
      const saved = await saveWorkflowDraft(
        apiClient,
        workspace.id,
        workflowId,
        {
          graph: reviewed.draft.graph,
          etag: reviewed.representationTag,
        },
      );
      store
        .getState()
        .acceptProposal(
          { draft: reviewed.base, etag: reviewed.representationTag },
          saved,
          before.generation,
        );
      await reconcileQuerySnapshot(
        queryClient,
        workflowDraftKeys.detail(userId, workspace.id, workflowId),
        { kind: 'accepted', value: saved },
      );
    },
  });
  return { disclosure, proposal, apply };
}
