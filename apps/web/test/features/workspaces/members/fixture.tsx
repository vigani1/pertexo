import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { timestamp } from '../../../support/fixtures/team';
export const invitationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export function invitation(email: string, id = invitationId) {
  return {
    id,
    email,
    role: 'viewer',
    status: 'pending',
    revision: 1,
    deliveryStatus: 'queued',
    expiresAt: new Date(Date.now() + 6.5 * 86_400_000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function sheet() {
  return document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
}

export function lens() {
  const element = sheet();
  if (element === null) throw new Error('No lens is open.');
  return within(element);
}

export function confirmation() {
  return screen.queryByRole('dialog', { name: /^Make /u });
}

export async function pickRole(
  actor: ReturnType<typeof userEvent.setup>,
  name: string,
  role: string,
) {
  await actor.click(
    await screen.findByRole('combobox', { name: `Role for ${name}` }),
  );
  await actor.click(await screen.findByRole('option', { name: role }));
}
