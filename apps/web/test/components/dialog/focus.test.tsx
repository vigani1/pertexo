import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

function Form({ focusAddress = false }: Readonly<{ focusAddress?: boolean }>) {
  const address = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('original');
  return (
    <Dialog open>
      <DialogContent initialFocus={focusAddress ? address : undefined}>
        <DialogTitle>Edit details</DialogTitle>
        <DialogDescription>Keep the field the person chose.</DialogDescription>
        <Input aria-label="Name" />
        <Input
          ref={address}
          aria-label="Address"
          value={value}
          onValueChange={setValue}
        />
      </DialogContent>
    </Dialog>
  );
}
it('keeps focus and every typed character when a person chooses another field before initial focus settles', async () => {
  const user = userEvent.setup();
  render(<Form />);
  const address = screen.getByLabelText('Address');
  await user.clear(address);
  await user.type(address, 'https://unsaved.example.test/sso');
  expect(address).toHaveFocus();
  expect(address).toHaveValue('https://unsaved.example.test/sso');
});

it('keeps default first-control focus when nobody has chosen a field', async () => {
  render(<Form />);
  await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
});
it('preserves the caller’s explicit initial focus target', async () => {
  render(<Form focusAddress />);
  await waitFor(() => expect(screen.getByLabelText('Address')).toHaveFocus());
});
