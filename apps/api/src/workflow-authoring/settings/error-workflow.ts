import {
  workflowErrorSettingsSchema,
  workflowErrorTargetsQuerySchema,
  workflowErrorTargetsPageSchema,
  workflowErrorSettingsRequestSchema,
  workflowErrorSettingsResponseSchema,
} from '@pertexo/contracts';
import type { WorkflowErrorDatabase } from '@pertexo/core/authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
  BROWSABLE_WORKSPACE_STATUSES,
} from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';
import { parseRequestBody } from '../../platform/http/index.js';

type ReadInput = WorkflowApplicationInput &
  Readonly<{ workflowId: string; signal?: AbortSignal }>;
type CommandInput = ReadInput &
  Readonly<{ request: unknown; idempotencyKey: string }>;

/** Operational policy never mutates drafts, publication or trigger state. */
export class WorkflowErrorUseCase {
  public constructor(
    private readonly persistence: WorkflowErrorDatabase,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  public async targets(input: ReadInput & Readonly<{ request: unknown }>) {
    await this.authorize(input, 'workflow:update');
    const request = workflowErrorTargetsQuerySchema.parse(input.request);
    return workflowErrorTargetsPageSchema.parse(
      await this.persistence.listTargets({
        ...this.context(input),
        ...(request.after === undefined ? {} : { after: request.after }),
      }),
    );
  }
  public async read(input: ReadInput) {
    input.signal?.throwIfAborted();
    await this.authorize(input, 'workflow:read');
    input.signal?.throwIfAborted();
    return workflowErrorSettingsSchema.parse(
      await this.persistence.readSettings(this.context(input)),
    );
  }
  public async update(input: CommandInput) {
    input.signal?.throwIfAborted();
    await this.authorize(input, 'workflow:update');
    input.signal?.throwIfAborted();
    const request = parseRequestBody(
      workflowErrorSettingsRequestSchema,
      input.request,
    );
    return workflowErrorSettingsResponseSchema.parse(
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
      allowedWorkspaceStatuses:
        capability === 'workflow:read'
          ? BROWSABLE_WORKSPACE_STATUSES
          : ['active'],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
  }
}
