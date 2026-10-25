import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { workflowApi, workflowId, workspaceId } from '../fixtures';
export async function limitField(event: ReturnType<typeof userEvent.setup>) {
  const section = await screen.findByRole('region', { name: 'Concurrency' });
  const toggle = await within(section).findByRole('button', {
    name: /^(Change|Close)$/u,
  });
  if (toggle.textContent === 'Change') await event.click(toggle);
  return within(section).findByRole('textbox', { name: 'Runs at once' });
}

export function sentence(start: string) {
  return (_: string, element: Element | null) =>
    element?.tagName === 'P' &&
    element.textContent.replace(/\s+/gu, ' ').startsWith(start);
}

export const path = `/w/${workspaceId}/workflows/${workflowId}/settings`;

export const endpoint = `${workflowApi}/concurrency`;

export function problem(status: number, code: string, extras = {}) {
  return HttpResponse.json(
    {
      type: `https://api.pertexo.test/problems/${code}`,
      title: 'Concurrency request failed',
      status,
      code,
      requestId: 'concurrency-test',
      ...extras,
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}
