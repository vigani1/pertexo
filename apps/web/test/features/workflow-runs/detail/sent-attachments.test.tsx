import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SentAttachments } from '@/features/workflow-runs/components/run-detail/data/sent-attachments';

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
