import {
  nodeValidationResponseSchema,
  type NodeTestRequest,
  type NodeTestExecuteAcceptedResponse,
  type NodeValidationResponse,
} from '@pertexo/contracts';
import {
  WorkflowNotFoundError,
  WorkflowStepSampleError,
  WorkflowRevisionConflictError,
  type WorkflowDraftRecord,
} from '@pertexo/core/authoring';
import {
  PREVIEW_EXECUTION_TIMEOUT_MAX_MS,
  PREVIEW_RETENTION_MAX_MS,
} from '@pertexo/core/previews';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  type ExpressionEvaluator,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';

import {
  authorizeWorkspace,
  authorizeWorkspaceOperation,
} from '../authorization/index.js';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../authorization/index.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { NodeTestInvalidError } from './errors.js';
import type { NodeTestingPersistence } from './ports.js';
import {
  prepareNodeValidation,
  type PreparedNodePreview,
} from './validation.js';
import { previewAcceptanceResponse } from './previews/response.js';
import {
  validationInputFields,
  digest,
  previewExecutionIdentity,
  normalizedExecutableNode,
} from './previews/request.js';

export { GetPreviewRunUseCase } from './previews/read.js';
export type NodeTestUseCaseInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  workflowId: string;
  nodeId: string;
  request: NodeTestRequest;
  idempotencyKey?: string;
  requestId?: string;
  traceId?: string;
  traceparent?: string;
}>;

export type Authorization = WorkspaceAuthorizationSource;

export class TestWorkflowNodeUseCase {
  public constructor(
    private readonly persistence: Pick<
      NodeTestingPersistence,
      'acceptPreview' | 'getDraft' | 'resolvePreviewReplay' | 'stepSamples'
    >,
    private readonly authorization: Authorization,
    private readonly now: () => Date = () => new Date(),
    private readonly expressionEvaluator?: ExpressionEvaluator,
  ) {}

  public async execute(
    input: NodeTestUseCaseInput,
  ): Promise<NodeValidationResponse | NodeTestExecuteAcceptedResponse> {
    const request = input.request;
    await this.authorize(input, 'workflow:update');
    const executionIdentity =
      request.mode === 'test_execute'
        ? previewExecutionIdentity(input, request)
        : undefined;
    if (executionIdentity !== undefined) {
      const replay = await this.replay(input, executionIdentity);
      if (replay !== undefined) return replay;
    }
    const draft = await this.currentDraft(input);
    if (draft.revision !== request.expectedRevision)
      throw new WorkflowRevisionConflictError(
        draft.revision,
        workflowDraftRepresentationTag({
          workflowId: draft.workflowId,
          revision: draft.revision,
          graph: draft.graphJson,
          compatibilityFingerprint: draft.compatibility.fingerprint,
        }),
      );
    const graph = parseWorkflowGraphDraft(draft.graphJson);
    const pinnedSampleId = await this.currentSample(input, request, draft);
    const prepared = await prepareNodeValidation({
      graph,
      nodeId: input.nodeId,
      ...(this.expressionEvaluator === undefined
        ? {}
        : { expressionEvaluator: this.expressionEvaluator }),
      ...validationInputFields(request),
      ...(pinnedSampleId === undefined ? {} : { pinnedSample: true }),
    });
    if (!('disclosure' in prepared))
      throw new NodeTestInvalidError(prepared.issues);

    if (
      pinnedSampleId === undefined &&
      Object.keys(prepared.executableNode.connectionRefs ?? {}).length > 0
    )
      await this.authorize(input, 'connection:use');

    if (request.mode === 'validate')
      return nodeValidationResponseSchema.parse({
        mode: 'validate',
        valid: prepared.issues.length === 0,
        revision: draft.revision,
        nodeId: input.nodeId,
        issues: prepared.issues,
        disclosure: prepared.disclosure,
      });

    if (executionIdentity === undefined)
      throw new Error('Preview execution identity is unavailable');
    if (prepared.issues.length > 0)
      throw new NodeTestInvalidError(prepared.issues);

    return this.accept(input, {
      request,
      executionIdentity,
      draft,
      graph,
      pinnedSampleId,
      prepared,
    });
  }

  private async replay(
    input: NodeTestUseCaseInput,
    executionIdentity: ReturnType<typeof previewExecutionIdentity>,
  ): Promise<NodeTestExecuteAcceptedResponse | undefined> {
    const replay = await this.persistence.resolvePreviewReplay({
      workspaceId: input.routeWorkspaceId,
      actorUserId: input.actor.actorId,
      workflowId: input.workflowId,
      ...executionIdentity,
    });
    if (replay !== null)
      return previewAcceptanceResponse(replay, { replayed: true });
    return undefined;
  }

  private async currentSample(
    input: NodeTestUseCaseInput,
    request: NodeTestRequest,
    draft: WorkflowDraftRecord,
  ): Promise<string | undefined> {
    const sample =
      request.mode === 'test_execute'
        ? await this.persistence.stepSamples.get({
            workspaceId: input.routeWorkspaceId,
            workflowId: input.workflowId,
            nodeId: input.nodeId,
            actorId: input.actor.actorId,
          })
        : undefined;
    if (sample !== undefined && sample.draftRevision !== draft.revision)
      throw new WorkflowStepSampleError('draft_changed');
    if (sample?.sample?.state === 'expired')
      throw new WorkflowStepSampleError('expired');
    if (sample?.sample?.state === 'stale')
      throw new WorkflowStepSampleError('stale');
    const pinnedSampleId = sample?.sample?.id;
    const pinnedSampleChanged =
      request.mode === 'test_execute' &&
      request.expectedSampleId !== undefined &&
      request.expectedSampleId !== (pinnedSampleId ?? null);
    if (pinnedSampleChanged) throw new WorkflowStepSampleError('changed');

    return pinnedSampleId;
  }

  private async accept(
    input: NodeTestUseCaseInput,
    {
      request,
      executionIdentity,
      draft,
      graph,
      pinnedSampleId,
      prepared,
    }: Readonly<{
      request: Extract<NodeTestRequest, Readonly<{ mode: 'test_execute' }>>;
      executionIdentity: ReturnType<typeof previewExecutionIdentity>;
      draft: WorkflowDraftRecord;
      graph: ReturnType<typeof parseWorkflowGraphDraft>;
      pinnedSampleId: string | undefined;
      prepared: PreparedNodePreview;
    }>,
  ): Promise<NodeTestExecuteAcceptedResponse> {
    const acceptedAt = this.now();
    const { keyHash, requestHash } = executionIdentity;
    const accepted = await this.persistence.acceptPreview({
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      actorUserId: input.actor.actorId,
      draftRevision: draft.revision,
      expectedSampleId: pinnedSampleId ?? null,
      draftFingerprint: digest(graph),
      nodeId: input.nodeId,
      definitionKey: prepared.definition.key,
      definitionVersion: prepared.definition.version,
      executorKey: prepared.executor.key,
      executorVersion: prepared.executor.version,
      executableNode: normalizedExecutableNode(prepared.executableNode),
      input: request.input,
      sideEffectClass: prepared.disclosure.sideEffectClass,
      mayContactProvider: prepared.disclosure.mayContactProvider,
      mayCauseExternalSideEffect:
        prepared.disclosure.mayCauseExternalSideEffect,
      dryRun: prepared.disclosure.dryRun,
      keyHash,
      requestHash,
      operation: 'preview.execute',
      ...(prepared.integration === undefined
        ? {}
        : {
            operationKey: prepared.integration.operationKey,
            providerKey: prepared.integration.providerKey,
          }),
      scope: `${input.actor.actorId}:${input.workflowId}`,
      ...(prepared.disclosure.sideEffectClass === 'idempotent_with_key'
        ? {
            providerIdempotencyKey: `pv1.${digest({
              workspaceId: input.routeWorkspaceId,
              workflowId: input.workflowId,
              nodeId: input.nodeId,
              requestHash,
            })}`,
          }
        : {}),
      expiresAt: new Date(acceptedAt.getTime() + PREVIEW_RETENTION_MAX_MS),
      executionDeadlineAt: new Date(
        acceptedAt.getTime() + PREVIEW_EXECUTION_TIMEOUT_MAX_MS,
      ),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    });
    return previewAcceptanceResponse(
      {
        id: accepted.previewRunId,
        workspaceId: input.routeWorkspaceId,
        workflowId: input.workflowId,
        draftRevision: draft.revision,
        nodeId: input.nodeId,
        status: accepted.status,
        ...(accepted.pinnedSampleId === undefined
          ? {}
          : {
              pinnedSampleId: accepted.pinnedSampleId,
              output: accepted.pinnedOutput,
            }),
        sideEffectClass: prepared.disclosure.sideEffectClass,
        mayContactProvider: prepared.disclosure.mayContactProvider,
        mayCauseExternalSideEffect:
          prepared.disclosure.mayCauseExternalSideEffect,
        dryRun: prepared.disclosure.dryRun,
        completedAt: accepted.completedAt ?? null,
        createdAt: accepted.acceptedAt,
        expiresAt: accepted.expiresAt,
      },
      { replayed: accepted.duplicate },
    );
  }

  private async currentDraft(
    input: NodeTestUseCaseInput,
  ): Promise<WorkflowDraftRecord> {
    const draft = await this.persistence.getDraft(
      input.routeWorkspaceId,
      input.workflowId,
      input.actor.actorId,
    );
    if (draft === null)
      throw new WorkflowNotFoundError('Workflow is not visible');
    return draft;
  }

  private async authorize(
    input: NodeTestUseCaseInput,
    capability: 'workflow:update' | 'connection:use',
  ): Promise<void> {
    const authorize =
      capability === 'workflow:update'
        ? authorizeWorkspaceOperation
        : authorizeWorkspace;
    await authorize({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: ['active'],
      ...(capability === 'workflow:update' &&
      input.authorizedWorkspace !== undefined
        ? { authorizedWorkspace: input.authorizedWorkspace }
        : {}),
    });
  }
}
