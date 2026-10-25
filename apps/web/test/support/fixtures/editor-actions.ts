import { fireEvent, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { coldStart } from './run';
export async function findCanvas() {
  return within(await screen.findByRole('application', {}, coldStart));
}

export function pressSave() {
  fireEvent.keyDown(window, { key: 's', metaKey: true });
}

export async function choose(event: UserEvent, label: string, option: string) {
  await event.click(screen.getByLabelText(label));
  await event.click(await screen.findByRole('option', { name: option }));
}

export function toastAction(name: string) {
  const action = screen
    .getAllByRole('button', { name })
    .find((button) => button.closest('header') === null);
  if (action === undefined) throw new Error(`No notification action ${name}`);
  return action;
}

export function addStepButton(name: RegExp) {
  return within(
    screen.getByRole('complementary', { name: 'Add a step' }),
  ).getByRole('button', { name });
}

export async function openRunLens(event: UserEvent) {
  const recover = screen.queryByRole('button', {
    name: 'Recover unconfirmed run',
  });
  if (recover !== null) {
    await event.click(recover);
    return;
  }
  await event.click(await screen.findByRole('button', { name: 'Run' }));
  await event.click(
    await screen.findByRole('menuitem', { name: 'Run with input…' }),
  );
}

export async function checkNow(event: UserEvent) {
  await event.click(
    screen.getByRole('button', { name: /Not checked yet|No issues|issue/u }),
  );
  await event.click(await screen.findByRole('button', { name: 'Check again' }));
}

export function findPaused() {
  return screen.findByRole('heading', { name: 'Editor paused' });
}
