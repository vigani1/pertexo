import { ApiError } from '@/lib/api/error';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { describe, expect, it } from 'vitest';

import { apiClientFor, panel, previewSummary } from './fixture';

describe('node test panel', () => {
  it('resumes observation of an accepted test instead of running it again', async () => {
    let submissions = 0;
    let observations = 0;
    const apiClient = apiClientFor((request) => {
      if (request.path.includes('/draft/nodes/')) {
        submissions += 1;
        return Promise.resolve({
          mode: 'test_execute',
          replayed: false,
          preview: previewSummary('running'),
        });
      }
      observations += 1;
      if (observations === 1)
        return Promise.reject(
          new ApiError({ kind: 'network', message: 'stream unavailable' }),
        );
      return Promise.resolve({ preview: previewSummary('succeeded') });
    });
    render(panel({ apiClient, nodeId: 'node-a' }));
    const event = userEvent.setup();

    await event.click(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    );
    await event.click(screen.getByRole('button', { name: 'Run test' }));
    expect(
      await screen.findByRole('button', { name: 'Check test status' }),
    ).toBeVisible();
    expect(submissions).toBe(1);
    fireEvent.change(screen.getByLabelText('Sample input (JSON)'), {
      target: { value: '{\n}' },
    });
    expect(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Check test status' }),
    ).toBeEnabled();

    await event.click(
      screen.getByRole('button', { name: 'Check test status' }),
    );
    await waitFor(() => {
      expect(screen.getByText('Test passed')).toBeVisible();
    });
    expect(submissions).toBe(1);
    expect(observations).toBe(2);
  }, 7_000);
});
