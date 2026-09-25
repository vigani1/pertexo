import { IdentityError, type IdentityClock } from '../identity/index.js';
import type { IdentityWorkspacePersistence } from './ports.js';
import {
  memberCommandFields,
  type WorkspaceMemberCommandInput,
} from './member-role-use-case.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceOperation,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';
import {
  workspaceLeaveRequestSchema,
  workspaceLeaveResponseSchema,
  workspaceMemberStatusRequestSchema,
  workspaceMemberStatusResponseSchema,
  workspaceOwnershipTransferRequestSchema,
  workspaceOwnershipTransferResponseSchema,
  type WorkspaceLeaveResponse,
  type WorkspaceMemberStatusResponse,
  type WorkspaceOwnershipTransferResponse,
} from './types.js';

type MembershipLifecyclePersistence = Required<
  Pick<
    IdentityWorkspacePersistence,
    | 'leaveWorkspace'
    | 'suspendWorkspaceMember'
    | 'reactivateWorkspaceMember'
    | 'transferWorkspaceOwnership'
  >
>;

/** The same five-minute bound as ADR 043 invitation proof. */
const FRESH_SIGN_IN_MILLIS = 5 * 60_000;

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
        workspaceLeaveRequestSchema.parse(input.request);
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

  public suspend(
    input: WorkspaceMemberCommandInput,
  ): Promise<WorkspaceMemberStatusResponse> {
    return this.changeStatus(
      input,
      IDENTITY_WORKSPACE_OPERATION.workspaceMemberSuspend,
      (command) => this.persistence.suspendWorkspaceMember(command),
    );
  }

  public reactivate(
    input: WorkspaceMemberCommandInput,
  ): Promise<WorkspaceMemberStatusResponse> {
    return this.changeStatus(
      input,
      IDENTITY_WORKSPACE_OPERATION.workspaceMemberReactivate,
      (command) => this.persistence.reactivateWorkspaceMember(command),
    );
  }

  /** Needs a sign-in from the last five minutes (ADR 047). */
  public transferOwnership(
    input: WorkspaceMemberCommandInput & Readonly<{ signedInAt: Date }>,
  ): Promise<WorkspaceOwnershipTransferResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.workspaceOwnershipTransfer,
      async () => {
        const request = workspaceOwnershipTransferRequestSchema.parse(
          input.request,
        );
        if (
          this.clock.now().getTime() - input.signedInAt.getTime() >
          FRESH_SIGN_IN_MILLIS
        )
          throw new IdentityError('identity.session_not_fresh');
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
    input: WorkspaceMemberCommandInput,
    operation: IdentityWorkspaceOperation,
    send: MembershipLifecyclePersistence['suspendWorkspaceMember'],
  ): Promise<WorkspaceMemberStatusResponse> {
    return this.telemetry.measure(operation, async () => {
      const request = workspaceMemberStatusRequestSchema.parse(input.request);
      const result = await send({
        ...memberCommandFields(input),
        expectedRoleRevision: request.expectedRoleRevision,
      });
      return workspaceMemberStatusResponseSchema.parse(result);
    });
  }
}
