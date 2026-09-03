import { createHash } from 'node:crypto';

import {
  nodeTestExecuteAcceptedResponseSchema,
  nodeValidationResponseSchema,
  previewRunResponseSchema,
  type NodeTestRequest,
  type NodeTestExecuteAcceptedResponse,
  type NodeValidationResponse,
  type PreviewRunResponse,
} from '@pertexo/contracts/node-testing';
import {
  PreviewIdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  type WorkflowDraftRecord,
} from '@pertexo/database/api';
import type { RegistryRelease } from '@pertexo/node-sdk';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import {
  parseWorkflowGraphDraft,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/graph';
import { composeExecutableCompatibilityRelease } from '@pertexo/workflow-engine';
import { z } from 'zod';

import {
  authorizeWorkspace,
  authorizeWorkspaceOperation,
} from '../workspaces/index.js';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
  WorkspaceAuthorizationPort,
} from '../workspaces/index.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import {
  NodeTestIdempotencyConflictError,
  NodeTestIdempotencyRequiredError,
  NodeTestInvalidError,
} from './errors.js';
import type { NodeTestingPersistence } from './ports.js';
import { prepareNodeValidation } from './validation.js';

const PREVIEW_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PREVIEW_EXECUTION_TIMEOUT_MS = 5 * 60 * 1_000;
const executableNodeSchema = z.record(z.string(), z.json());

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

type Authorization = WorkspaceAuthorizationSource | WorkspaceAuthorizationPort;

export class TestWorkflowNodeUseCase {
  public constructor(
    private readonly persistence: Pick<
      NodeTestingPersistence,
      'acceptPreview' | 'getDraft'
    >,
    private readonly authorization: Authorization,
    private readonly release: RegistryRelease,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute(
    input: NodeTestUseCaseInput,
  ): Promise<NodeValidationResponse | NodeTestExecuteAcceptedResponse> {
    const request = input.request;
    await this.authorize(input, 'workflow:update');
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
    const prepared = await prepareNodeValidation({
      graph,
      nodeId: input.nodeId,
      release: this.release,
      ...(request.mode === 'validate'
        ? request.sampleInput === undefined
          ? {}
          : { sampleInput: request.sampleInput }
        : request.input.kind === 'manual'
          ? { sampleInput: request.input.value }
          : { deferInput: true }),
    });
    if (!('disclosure' in prepared))
      throw new NodeTestInvalidError(prepared.issues);

    if (Object.keys(prepared.executableNode.connectionRefs ?? {}).length > 0)
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

    if (input.idempotencyKey === undefined)
      throw new NodeTestIdempotencyRequiredError();
    if (prepared.issues.length > 0)
      throw new NodeTestInvalidError(prepared.issues);

    const acceptedAt = this.now();
    const executionRelease = composeExecutableCompatibilityRelease(
      this.release,
    );
    const requestHash = digest({
      domain: 'pertexo.preview.execute-request',
      schemaVersion: 1,
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      request,
    });
    try {
      const accepted = await this.persistence.acceptPreview({
        workspaceId: input.routeWorkspaceId,
        workflowId: input.workflowId,
        actorUserId: input.actor.actorId,
        draftRevision: draft.revision,
        draftFingerprint: digest(graph),
        nodeId: input.nodeId,
        definitionKey: prepared.definition.key,
        definitionVersion: prepared.definition.version,
        executorKey: prepared.executor.key,
        executorVersion: prepared.executor.version,
        compatibilityReleaseEpoch: executionRelease.epoch,
        compatibilityReleaseFingerprint: executionRelease.fingerprint,
        executableNode: canonicalExecutableNode(prepared.executableNode),
        input: request.input,
        sideEffectClass: prepared.disclosure.sideEffectClass,
        mayContactProvider: prepared.disclosure.mayContactProvider,
        mayCauseExternalSideEffect:
          prepared.disclosure.mayCauseExternalSideEffect,
        dryRun: prepared.disclosure.dryRun,
        keyHash: createHash('sha256')
          .update(input.idempotencyKey)
          .digest('hex'),
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
        expiresAt: new Date(acceptedAt.getTime() + PREVIEW_RETENTION_MS),
        executionDeadlineAt: new Date(
          acceptedAt.getTime() + PREVIEW_EXECUTION_TIMEOUT_MS,
        ),
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        ...(input.traceparent === undefined
          ? {}
          : { traceparent: input.traceparent }),
      });
      return nodeTestExecuteAcceptedResponseSchema.parse({
        mode: 'test_execute',
        replayed: accepted.duplicate,
        preview: {
          id: accepted.previewRunId,
          workspaceId: input.routeWorkspaceId,
          workflowId: input.workflowId,
          draftRevision: draft.revision,
          nodeId: input.nodeId,
          status: accepted.status,
          disclosure: prepared.disclosure,
          output: null,
          safeErrorCode: null,
          createdAt: accepted.acceptedAt.toISOString(),
          startedAt: null,
          completedAt: null,
          expiresAt: accepted.expiresAt.toISOString(),
        },
      });
    } catch (error: unknown) {
      if (error instanceof PreviewIdempotencyConflictError)
        throw new NodeTestIdempotencyConflictError();
      throw error;
    }
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

export class GetPreviewRunUseCase {
  public constructor(
    private readonly persistence: Pick<NodeTestingPersistence, 'readPreview'>,
    private readonly authorization: Authorization,
  ) {}

  public async execute(
    input: Readonly<{
      actor: ActorContext;
      routeWorkspaceId: string;
      authorizedWorkspace?: AuthorizedWorkspaceContext;
      previewRunId: string;
    }>,
  ): Promise<PreviewRunResponse> {
    await authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: 'workflow:update',
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: ['active'],
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
    const preview = await this.persistence.readPreview({
      workspaceId: input.routeWorkspaceId,
      actorUserId: input.actor.actorId,
      previewRunId: input.previewRunId,
    });
    if (preview === null)
      throw new WorkflowNotFoundError('Preview is not visible');
    return previewRunResponseSchema.parse({
      preview: {
        id: preview.id,
        workspaceId: preview.workspaceId,
        workflowId: preview.workflowId,
        draftRevision: preview.draftRevision,
        nodeId: preview.nodeId,
        status: preview.status,
        disclosure: {
          sideEffectClass: preview.sideEffectClass,
          mayContactProvider: preview.mayContactProvider,
          mayCauseExternalSideEffect: preview.mayCauseExternalSideEffect,
          dryRun: preview.dryRun,
        },
        output:
          preview.output === null
            ? null
            : preview.output.kind === 'inline'
              ? { kind: 'inline', value: preview.output.value }
              : {
                  kind: 'artifact',
                  artifactId: preview.output.artifactId,
                },
        safeErrorCode: preview.safeErrorCode,
        createdAt: preview.createdAt.toISOString(),
        startedAt: preview.startedAt?.toISOString() ?? null,
        completedAt: preview.completedAt?.toISOString() ?? null,
        expiresAt: preview.expiresAt.toISOString(),
      },
    });
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalExecutableNode(value: unknown) {
  const parsed: unknown = JSON.parse(canonicalJson(value));
  return executableNodeSchema.parse(parsed);
}
