import {
  workflowConcurrencySettingsSchema,
  workflowConcurrencySettingsRequestSchema,
  workflowConcurrencyCommandResponseSchema,
} from '@pertexo/contracts';
import type { WorkflowConcurrencyDatabase } from '@pertexo/database/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import type { WorkflowApplicationInput } from './ports.js';

type ReadInput = WorkflowApplicationInput &
  Readonly<{ workflowId: string; signal?: AbortSignal }>;
type CommandInput = ReadInput &
  Readonly<{ request: unknown; idempotencyKey: string }>;

/** Operational policy never mutates drafts, publication or trigger state. */
export class WorkflowConcurrencyUseCase {
  public constructor(
    private readonly persistence: WorkflowConcurrencyDatabase,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  public async read(input: ReadInput) {
    input.signal?.throwIfAborted();
    await this.authorize(input, 'workflow:read');
    input.signal?.throwIfAborted();
    return workflowConcurrencySettingsSchema.parse(
      await this.persistence.readSettings(this.context(input)),
    );
  }
  public async update(input: CommandInput) {
    input.signal?.throwIfAborted();
    await this.authorize(input, 'workflow:update');
    input.signal?.throwIfAborted();
    const request = workflowConcurrencySettingsRequestSchema.parse(
      input.request,
    );
    return workflowConcurrencyCommandResponseSchema.parse(
      await this.persistence.updateSettings({
        ...this.context(input),
        ...request,
        idempotencyKey: input.idempotencyKey,
        requestId: input.actor.requestId,
        ...(input.actor.traceId === undefined
          ? {}
          : { traceId: input.actor.traceId }),
      }),
    );
  }
  private context(input: ReadInput) {
    return {
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      actorId: input.actor.actorId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }
  private authorize(
    input: ReadInput,
    capability: 'workflow:read' | 'workflow:update',
  ) {
    return authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability,
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: ['active'],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
  }
}
