import { authorizeAuthoringOperation } from '../commands/authorization.js';
import type { z } from 'zod';
import type { workflowConcurrencySettingsRequestSchema } from '@pertexo/contracts';
import {
  workflowConcurrencySettingsSchema,
  workflowConcurrencyCommandResponseSchema,
} from '@pertexo/contracts';
import type { WorkflowConcurrencyStore } from '@pertexo/core/authoring';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import type { WorkflowApplicationInput } from '../ports.js';

type ReadInput = WorkflowApplicationInput &
  Readonly<{ workflowId: string; signal?: AbortSignal }>;
type CommandInput<Request> = ReadInput &
  Readonly<{ request: Request; idempotencyKey: string }>;

/** Operational policy never mutates drafts, publication or trigger state. */
export class WorkflowConcurrencyUseCase {
  public constructor(
    private readonly persistence: WorkflowConcurrencyStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  public async read(input: ReadInput) {
    input.signal?.throwIfAborted();
    await authorizeAuthoringOperation(
      input,
      'workflow:read',
      this.authorization,
    );
    input.signal?.throwIfAborted();
    return workflowConcurrencySettingsSchema.parse(
      await this.persistence.readSettings(this.context(input)),
    );
  }
  public async update(
    input: CommandInput<
      z.output<typeof workflowConcurrencySettingsRequestSchema>
    >,
  ) {
    input.signal?.throwIfAborted();
    await authorizeAuthoringOperation(
      input,
      'workflow:update',
      this.authorization,
    );
    input.signal?.throwIfAborted();
    const { request } = input;
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
}
