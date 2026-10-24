import { createWorkflowTemplateOriginReader } from '../portability/template-origin.queries.js';

import type {
  ListWorkflowsInput,
  ListWorkflowVersionsInput,
} from './contract.js';

import type {
  ReadStore,
  WorkflowAuthoringReadContext,
} from './reads/contract.js';
import {
  validateAuthoringDraft,
  readAuthoringDraft,
} from './reads/drafts.queries.js';
import {
  readAuthoringVersion,
  listAuthoringVersions,
} from './reads/versions.queries.js';
import {
  readAuthoringWorkflow,
  listAuthoringWorkflows,
} from './reads/workflows.queries.js';

export function createWorkflowAuthoringReadStore(
  context: WorkflowAuthoringReadContext,
): ReadStore {
  return Object.freeze({
    getWorkflowWithTemplateOrigin: createWorkflowTemplateOriginReader(context),
    validateDraft: (
      workspaceId: string,
      workflowId: string,
      actorId: string,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) =>
      validateAuthoringDraft(context, workspaceId, {
        workflowId,
        actorId,
        options,
      }),
    getWorkflow: (workspaceId: string, workflowId: string, actorId: string) =>
      readAuthoringWorkflow(context, workspaceId, workflowId, actorId),
    listWorkflows: (input: ListWorkflowsInput) =>
      listAuthoringWorkflows(context, input),
    getDraft: (workspaceId: string, workflowId: string, actorId: string) =>
      readAuthoringDraft(context, workspaceId, workflowId, actorId),
    getVersion: (
      workspaceId: string,
      workflowId: string,
      versionId: string,
      actorId: string,
    ) =>
      readAuthoringVersion(context, workspaceId, {
        workflowId,
        versionId,
        actorId,
      }),
    listVersions: (input: ListWorkflowVersionsInput) =>
      listAuthoringVersions(context, input),
  });
}
