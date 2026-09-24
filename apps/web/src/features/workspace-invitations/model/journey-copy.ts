import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';

type Role = Extract<
  InvitationAcceptanceJourney,
  { state: 'completed' }
>['role'];

const ROLE_COPY: Record<Role, Readonly<{ name: string; meaning: string }>> = {
  owner: {
    name: 'Owner',
    meaning: 'Everything, including renaming or deleting the workspace',
  },
  admin: {
    name: 'Admin',
    meaning: 'Manages members, connections and every workflow',
  },
  builder: { name: 'Builder', meaning: 'Builds, publishes and runs workflows' },
  operator: {
    name: 'Operator',
    meaning: 'Starts, cancels and replays runs',
  },
  viewer: {
    name: 'Viewer',
    meaning: 'Sees workflows and runs without changing them',
  },
};

export function roleCopy(role: Role) {
  return ROLE_COPY[role];
}

export type DeadEndState = Extract<
  InvitationAcceptanceJourney['state'],
  'expired' | 'revoked' | 'superseded' | 'unavailable'
>;

/** One human sentence per dead end; never the raw state word. */
export const DEAD_END_COPY: Record<
  DeadEndState,
  Readonly<{ title: string; sentence: string }>
> = {
  expired: {
    title: 'This invitation has expired',
    sentence: 'Invitations only work for a limited time, and this one ran out.',
  },
  revoked: {
    title: 'This invitation was withdrawn',
    sentence: 'Someone in the workspace cancelled it before it was accepted.',
  },
  superseded: {
    title: 'A newer invitation replaced this one',
    sentence: 'Only the most recent invitation email for this address works.',
  },
  unavailable: {
    title: 'This invitation link can’t be used',
    sentence:
      'It may have been used already, or this browser lost track of it.',
  },
};

export function isDeadEnd(
  state: InvitationAcceptanceJourney['state'],
): state is DeadEndState {
  return state in DEAD_END_COPY;
}
