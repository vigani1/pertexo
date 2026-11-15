import { requestIdentifiers } from '../../workspaces/request/caller.js';
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
import type { NodeTestServiceInput } from '../node-testing.service.js';
import type {
  StepSampleDeleteRequest,
  StepSampleListResponse,
  StepSampleWriteRequest,
} from '@pertexo/contracts';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';

type ReadInput = Pick<
  NodeTestServiceInput,
  'actor' | 'routeWorkspaceId' | 'authorizedWorkspace' | 'workflowId'
> &
  Readonly<{ signal?: AbortSignal }>;
type NodeInput = ReadInput & Readonly<{ nodeId: string }>;
type CommandInput<Request> = NodeInput &
  Readonly<{ request: Request; idempotencyKey: string }>;
export class StepSamplesService {
  constructor(
    private readonly store: WorkflowStepSampleStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async list(input: ReadInput): Promise<StepSampleListResponse> {
    await this.authorize(input, { write: false });
    const result = await this.store.list(this.scope(input));
    return {
      ...result,
      items: result.items.map(metadata),
      limits: STORED_EXECUTION_VALUE_LIMITS,
    };
  }
  async get(input: NodeInput) {
    await this.authorize(input, { write: false });
    const result = await this.store.get({
      ...this.scope(input),
      nodeId: input.nodeId,
    });
    return {
      sample: result.sample === null ? null : metadata(result.sample),
      output: result.output?.kind === 'inline' ? result.output.value : null,
      draftRevision: result.draftRevision,
      limits: STORED_EXECUTION_VALUE_LIMITS,
    };
  }
  async put(input: CommandInput<StepSampleWriteRequest>) {
    await this.authorize(input, { write: true });
    return await this.store.put({ ...this.command(input), ...input.request });
  }
  async remove(input: CommandInput<StepSampleDeleteRequest>) {
    await this.authorize(input, { write: true });
    return await this.store.remove({
      ...this.command(input),
      ...input.request,
    });
  }
  private scope(input: ReadInput) {
    return {
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      actorId: input.actor.actorId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }
  private command(input: CommandInput<unknown>) {
    return {
      ...this.scope(input),
      nodeId: input.nodeId,
      idempotencyKey: input.idempotencyKey,
      ...requestIdentifiers(input.actor),
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
        ? ACTIVE_WORKSPACE_STATUSES
        : BROWSABLE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    });
  }
}
function metadata(
  sample: SampleMetadata,
): StepSampleListResponse['items'][number] {
  return {
    ...sample,
    createdAt: sample.createdAt.toISOString(),
    expiresAt: sample.expiresAt.toISOString(),
  };
}
