import { assertRecentSignIn } from '../../identity/recent-sign-in.js';
import type { IdentityClock } from '../../identity/index.js';
import type { IdentityWorkspacePersistence } from '../ports.js';
import {
  memberCommandFields,
  type WorkspaceMemberCommandInput,
} from './role.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceOperation,
  type IdentityWorkspaceTelemetry,
} from '../telemetry.js';
import type {
  workspaceMemberStatusRequestSchema,
  workspaceOwnershipTransferRequestSchema,
} from '@pertexo/contracts';
import type { z } from 'zod';
import {
  workspaceLeaveResponseSchema,
  workspaceMemberStatusResponseSchema,
  workspaceOwnershipTransferResponseSchema,
  type WorkspaceLeaveResponse,
  type WorkspaceMemberStatusResponse,
  type WorkspaceOwnershipTransferResponse,
} from '../workspace-transport.js';

type MembershipLifecyclePersistence = Pick<
  IdentityWorkspacePersistence,
  | 'leaveWorkspace'
  | 'suspendWorkspaceMember'
  | 'reactivateWorkspaceMember'
  | 'transferWorkspaceOwnership'
>;

type StatusCommand = WorkspaceMemberCommandInput<
  z.output<typeof workspaceMemberStatusRequestSchema>
>;

/**
 * ADR 047: leaving a workspace, suspending and reactivating members, and
 * transferring ownership. Persistence rechecks every rule under lock.
 */
export class WorkspaceMembershipLifecycleUseCase {
  public constructor(
    private readonly persistence: MembershipLifecyclePersistence,
    private readonly clock: IdentityClock,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  /** The actor leaves; the route's target is the actor themselves. */
  public leave(
    input: WorkspaceMemberCommandInput,
  ): Promise<WorkspaceLeaveResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceMemberLeave,
      async () => {
        const fields = memberCommandFields(input);
        const result = await this.persistence.leaveWorkspace({
          workspaceId: fields.workspaceId,
          actorUserId: fields.actorUserId,
          idempotencyKey: fields.idempotencyKey,
          ...(fields.requestId === undefined
            ? {}
            : { requestId: fields.requestId }),
          ...(fields.traceId === undefined ? {} : { traceId: fields.traceId }),
        });
        return workspaceLeaveResponseSchema.parse(result);
      },
    );
  }

  public suspend(input: StatusCommand): Promise<WorkspaceMemberStatusResponse> {
    return this.changeStatus(
      input,
      IDENTITY_WORKSPACE_OPERATION.workspaceMemberSuspend,
      (command) => this.persistence.suspendWorkspaceMember(command),
    );
  }

  public reactivate(
    input: StatusCommand,
  ): Promise<WorkspaceMemberStatusResponse> {
    return this.changeStatus(
      input,
      IDENTITY_WORKSPACE_OPERATION.workspaceMemberReactivate,
      (command) => this.persistence.reactivateWorkspaceMember(command),
    );
  }

  /** Needs a sign-in from the last five minutes (ADR 047). */
  public transferOwnership(
    input: WorkspaceMemberCommandInput<
      z.output<typeof workspaceOwnershipTransferRequestSchema>
    > &
      Readonly<{ signedInAt: Date }>,
  ): Promise<WorkspaceOwnershipTransferResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceOwnershipTransfer,
      async () => {
        const { request } = input;
        assertRecentSignIn(input.signedInAt, this.clock.now());
        const result = await this.persistence.transferWorkspaceOwnership({
          ...memberCommandFields(input),
          expectedRoleRevision: request.expectedRoleRevision,
          expectedOwnerRoleRevision: request.expectedOwnerRoleRevision,
        });
        return workspaceOwnershipTransferResponseSchema.parse(result);
      },
    );
  }

  private changeStatus(
    input: StatusCommand,
    operation: IdentityWorkspaceOperation,
    send: MembershipLifecyclePersistence['suspendWorkspaceMember'],
  ): Promise<WorkspaceMemberStatusResponse> {
    return this.telemetry.measure(operation, async () => {
      const result = await send({
        ...memberCommandFields(input),
        expectedRoleRevision: input.request.expectedRoleRevision,
      });
      return workspaceMemberStatusResponseSchema.parse(result);
    });
  }
}
