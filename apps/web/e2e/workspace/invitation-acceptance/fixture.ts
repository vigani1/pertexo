export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const intentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const csrfToken = 'invitation-acceptance-csrf-token-123456';

export const sessionCsrfToken =
  'invitation-session-csrf-token-123456789012345678';

export const token = `wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`;

const staleIntentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const staleBinding = `wb1.${workspaceId}.${staleIntentId}.${'b'.repeat(43)}.${'c'.repeat(43)}`;

export const recoveredBinding = `wb1.${workspaceId}.${intentId}.${'d'.repeat(43)}.${'e'.repeat(43)}`;

export function readyJourney() {
  return {
    state: 'ready',
    intentId,
    expiresAt: '2026-09-19T19:00:00.000Z',
    csrfToken,
    invitationRevision: 2,
    role: 'builder',
    sessionRotationRequired: true,
    workspace: { id: workspaceId, name: 'Control Operations' },
  } as const;
}
