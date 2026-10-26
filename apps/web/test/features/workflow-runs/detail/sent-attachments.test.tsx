import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SentAttachments } from '@/features/workflow-runs/components/run-detail/data/sent-attachments';

it('shows the files a Send email step attached as chips with names and sizes', () => {
  render(
    <SentAttachments
      value={{
        emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
        attachments: [
          {
            filename: 'weekly-report.csv',
            mediaType: 'text/csv; charset=utf-8',
            byteLength: 48_213,
          },
          {
            filename: 'Terms.pdf',
            mediaType: 'application/pdf',
            byteLength: 1_342_177,
          },
        ],
      }}
    />,
  );
  const sent = screen.getByRole('region', { name: 'Attachments sent' });
  expect(sent).toHaveTextContent('2 files sent · 1.3 MB');
  const chips = within(sent).getAllByRole('listitem');
  expect(chips[0]).toHaveTextContent('weekly-report.csv');
  expect(chips[0]).toHaveTextContent('47.1 KB');
  expect(chips[1]).toHaveTextContent('Terms.pdf');
});

it('shows nothing for an email without attachments or another step’s output', () => {
  const { container } = render(
    <>
      <SentAttachments
        value={{ emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' }}
      />
      <SentAttachments value={{ attachments: [{ filename: 'x' }] }} />
    </>,
  );
  expect(container).toBeEmptyDOMElement();
});
