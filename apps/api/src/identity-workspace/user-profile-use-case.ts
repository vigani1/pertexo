import type {
  IdentityWorkspacePersistence,
  UserProfilePersistenceRecord,
} from './ports.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';
import {
  userProfileResponseSchema,
  userProfileUpdateRequestSchema,
  userProfileUpdateResponseSchema,
  type UserProfileResponse,
  type UserProfileUpdateResponse,
} from './types.js';

type ProfilePersistence = Required<
  Pick<IdentityWorkspacePersistence, 'updateUserProfile'>
>;

/** The self-profile projection: no credentials, sessions or provider data. */
export function projectUserProfile(
  user: UserProfilePersistenceRecord,
): UserProfileResponse {
  return userProfileResponseSchema.parse({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    revision: user.profileRevision,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  });
}

/**
 * ADR 043: the signed-in user changes their own display name at the profile
 * revision they saw. The session authority already identified the actor.
 */
export class UpdateUserProfileUseCase {
  public constructor(
    private readonly persistence: ProfilePersistence,
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  public execute(
    input: Readonly<{
      actorUserId: string;
      request: unknown;
      idempotencyKey: string;
    }>,
  ): Promise<UserProfileUpdateResponse> {
    return this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.userProfileUpdate,
      async () => {
        const request = userProfileUpdateRequestSchema.parse(input.request);
        const result = await this.persistence.updateUserProfile({
          actorUserId: input.actorUserId,
          displayName: request.displayName,
          expectedRevision: request.expectedRevision,
          idempotencyKey: input.idempotencyKey,
        });
        return userProfileUpdateResponseSchema.parse({
          profile: projectUserProfile(result.user),
          changed: result.changed,
          replayed: result.replayed,
        });
      },
    );
  }
}
