import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

/** A new import confirmation reviews compatibility again; it never resends a held command. */
export async function confirmNewImport(
  event: ReturnType<typeof userEvent.setup>,
) {
  await event.click(screen.getByRole('button', { name: 'Preview import' }));
  await screen.findByText(/Compatible with this workspace/u);
  await event.click(
    screen.getByRole('button', { name: 'Import unpublished draft' }),
  );
}
