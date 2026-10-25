export type InvitationAcceptanceRefusal =
  | 'member_inactive'
  | 'expired'
  | 'superseded'
  | 'proof_expired'
  | 'revision_conflict'
  | 'workspace_inactive'
  | 'recipient_mismatch';

type InvitationFacts = Readonly<{
  status: string;
  expiresAt: Date;
  revision: number;
  email: string;
}>;
type SessionFacts = Readonly<{ userId: string }>;

/** Evaluate one locked snapshot; the caller retains locks until its writes commit. */
export function decideInvitationAcceptance<
  Invitation extends InvitationFacts,
  Session extends SessionFacts,
>({
  actorUserId,
  invitationRevision,
  intent,
  current,
  previewSessionId,
  sourceSession,
  userStatus,
  workspaceStatus,
  now,
}: Readonly<{
  actorUserId: string;
  invitationRevision: number;
  intent: Readonly<{
    expiresAt: Date;
    status: string;
    verifiedSessionId: string | null;
    verifiedUserId: string | null;
    verifiedAt: Date | null;
    invitationRevision: number;
    verifiedEmail: string | null;
  }>;
  current: Invitation | undefined;
  previewSessionId: string | null;
  sourceSession: Session | undefined;
  userStatus: string | undefined;
  workspaceStatus: string | undefined;
  now: Date;
}>):
  | Readonly<{
      allowed: false;
      reason: InvitationAcceptanceRefusal;
      message: string;
    }>
  | Readonly<{ allowed: true; current: Invitation; sourceSession: Session }> {
  if (userStatus !== 'active')
    return {
      allowed: false,
      reason: 'member_inactive',
      message: 'The accepting user is not active',
    };
  if (intent.expiresAt.getTime() <= now.getTime())
    return {
      allowed: false,
      reason: 'expired',
      message: 'The invitation journey expired',
    };
  if (intent.status === 'superseded')
    return {
      allowed: false,
      reason: 'superseded',
      message: 'The invitation journey was superseded',
    };
  const verificationUnavailable =
    sourceSession?.userId !== actorUserId ||
    intent.verifiedSessionId !== previewSessionId ||
    intent.status !== 'verified' ||
    intent.verifiedUserId !== actorUserId ||
    intent.verifiedAt === null ||
    now.getTime() - intent.verifiedAt.getTime() > 5 * 60_000;
  if (verificationUnavailable)
    return {
      allowed: false,
      reason: 'proof_expired',
      message: 'Fresh recipient verification is required',
    };
  if (intent.invitationRevision !== invitationRevision)
    return {
      allowed: false,
      reason: 'revision_conflict',
      message: 'The invitation changed',
    };
  if (workspaceStatus !== 'active')
    return {
      allowed: false,
      reason: 'workspace_inactive',
      message: 'The workspace is not active',
    };
  const invitationUnavailable =
    current?.status !== 'pending' ||
    current.expiresAt.getTime() <= now.getTime() ||
    current.revision !== invitationRevision;
  if (invitationUnavailable)
    return {
      allowed: false,
      reason: 'superseded',
      message: 'The invitation is no longer pending',
    };
  if (current.email !== intent.verifiedEmail)
    return {
      allowed: false,
      reason: 'recipient_mismatch',
      message: 'The verified recipient does not match',
    };

  return { allowed: true, current, sourceSession };
}
