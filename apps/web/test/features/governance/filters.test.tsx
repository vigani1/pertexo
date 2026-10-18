import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AuditFilters } from '@/features/governance/components/filters';

it('applies a person on Enter and narrows by what changed', async () => {
  const onApply = vi.fn(),
    user = userEvent.setup();
  render(<AuditFilters filters={{}} onApply={onApply} />);
  await user.type(
    screen.getByRole('searchbox', { name: 'Person' }),
    'Alice{Enter}',
  );
  expect(onApply).toHaveBeenLastCalledWith({ person: 'Alice' });

  await user.click(screen.getByRole('combobox', { name: 'What changed' }));
  await user.click(await screen.findByRole('option', { name: 'Workflows' }));
  expect(onApply).toHaveBeenLastCalledWith({ targetType: 'workflow' });
});

it('shows a narrowed action as a chip that widens the log again', async () => {
  const onApply = vi.fn(),
    user = userEvent.setup();
  render(
    <AuditFilters
      filters={{ action: 'workflow.published', person: 'Alice' }}
      actionWords="published a workflow"
      onApply={onApply}
    />,
  );
  await user.click(
    screen.getByRole('button', {
      name: 'Show every kind of event, not only “published a workflow”',
    }),
  );
  expect(onApply).toHaveBeenLastCalledWith({ person: 'Alice' });
});
