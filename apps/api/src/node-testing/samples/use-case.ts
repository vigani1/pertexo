import {
  stepSampleListResponseSchema,
  stepSampleResponseSchema,
  stepSampleWriteRequestSchema,
  stepSampleDeleteRequestSchema,
  stepSampleCommandResponseSchema,
} from '@pertexo/contracts';
import type {
  WorkflowStepSampleStore,
  SampleMetadata,
} from '@pertexo/core/authoring';
import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import {
  authorizeWorkspaceOperation,
  BROWSABLE_WORKSPACE_STATUSES,
} from '../../authorization/index.js';
import type { WorkspaceAuthorizationSource } from '../../workspaces/ports.js';
import type { NodeTestUseCaseInput } from '../use-case.js';

type ReadInput = Pick<
  NodeTestUseCaseInput,
  'actor' | 'routeWorkspaceId' | 'authorizedWorkspace' | 'workflowId'
> &
  Readonly<{ signal?: AbortSignal }>;
type NodeInput = ReadInput & Readonly<{ nodeId: string }>;
type CommandInput = NodeInput &
  Readonly<{ request: unknown; idempotencyKey: string }>;
export class StepSamplesUseCase {
  constructor(
    private readonly store: WorkflowStepSampleStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async list(input: ReadInput) {
    await this.authorize(input, { write: false });
    const result = await this.store.list(this.scope(input));
    return stepSampleListResponseSchema.parse({
      ...result,
      items: result.items.map(metadata),
      limits: STORED_EXECUTION_VALUE_LIMITS,
    });
  }
  async get(input: NodeInput) {
    await this.authorize(input, { write: false });
    const result = await this.store.get({
      ...this.scope(input),
      nodeId: input.nodeId,
    });
    return stepSampleResponseSchema.parse({
      sample: result.sample === null ? null : metadata(result.sample),
      output: result.output?.kind === 'inline' ? result.output.value : null,
      draftRevision: result.draftRevision,
      limits: STORED_EXECUTION_VALUE_LIMITS,
    });
  }
  async put(input: CommandInput) {
    await this.authorize(input, { write: true });
    const request = stepSampleWriteRequestSchema.parse(input.request);
    return stepSampleCommandResponseSchema.parse(
      await this.store.put({ ...this.command(input), ...request }),
    );
  }
  async remove(input: CommandInput) {
    await this.authorize(input, { write: true });
    const request = stepSampleDeleteRequestSchema.parse(input.request);
    return stepSampleCommandResponseSchema.parse(
      await this.store.remove({ ...this.command(input), ...request }),
    );
  }
  private scope(input: ReadInput) {
    return {
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      actorId: input.actor.actorId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }
  private command(input: CommandInput) {
    return {
      ...this.scope(input),
      nodeId: input.nodeId,
      idempotencyKey: input.idempotencyKey,
      requestId: input.actor.requestId,
      ...(input.actor.traceId === undefined
        ? {}
        : { traceId: input.actor.traceId }),
    };
  }
  private async authorize(
    input: ReadInput,
    { write }: Readonly<{ write: boolean }>,
  ) {
    input.signal?.throwIfAborted();
    await authorizeWorkspaceOperation({
      access: this.authorization,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
      capability: write ? 'workflow:update' : 'workflow:read',
      allowedWorkspaceStatuses: write
        ? ['active']
        : BROWSABLE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    });
  }
}
function metadata(sample: SampleMetadata) {
  return {
    ...sample,
    createdAt: sample.createdAt.toISOString(),
    expiresAt: sample.expiresAt.toISOString(),
  };
}
