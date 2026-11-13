// Test-only: what a person does with the schema-drawn setup.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

export function saved(): unknown {
  return JSON.parse(
    screen.getByRole('status', { name: 'Saved setup' }).textContent,
  );
}

export async function choose(name: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
}

export async function optionsOf(name: string): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name }));
  const options = (await screen.findAllByRole('option')).map(
    (option) => option.textContent,
  );
  await user.keyboard('{Escape}');
  return options;
}
