import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { FileDrop } from '@/components/ui/file-drop';

it('keeps the native chooser keyboard reachable and reports the chosen name and size', async () => {
  const onChoose = vi.fn();
  render(<FileDrop aria-label="CSV file" accept=".csv" onChoose={onChoose} />);
  const input = screen.getByLabelText('CSV file');
  const user = userEvent.setup();
  await user.tab();
  expect(input).toHaveFocus();
  const file = new File(['test'], 'orders.csv', { type: 'text/csv' });
  await user.upload(input, file);
  expect(onChoose).toHaveBeenCalledWith(file);
  expect(screen.getByText('orders.csv')).toBeVisible();
  expect(screen.getByText('4 B')).toBeVisible();
  // Choosing the same file again can retry a failed feature-owned read.
  await user.upload(input, file);
  expect(onChoose).toHaveBeenCalledTimes(2);
});

it('chooses a dropped file and ignores drops while disabled', () => {
  const onChoose = vi.fn();
  const { rerender } = render(
    <FileDrop aria-label="File" onChoose={onChoose} />,
  );
  const drop = screen.getByText('Drop a file here or choose file');
  const file = new File(['bytes'], 'input.json', { type: 'application/json' });
  fireEvent.dragOver(drop);
  expect(screen.getByText('Drop to choose this file')).toBeVisible();
  fireEvent.drop(drop, { dataTransfer: { files: [file] } });
  expect(onChoose).toHaveBeenCalledWith(file);
  expect(screen.getByText('input.json')).toBeVisible();
  rerender(<FileDrop aria-label="File" disabled onChoose={onChoose} />);
  fireEvent.drop(drop, { dataTransfer: { files: [file] } });
  expect(onChoose).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('File')).toBeDisabled();
});
