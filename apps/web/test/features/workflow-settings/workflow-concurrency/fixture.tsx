import { screen, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { workflowApi, workflowId, workspaceId } from '../fixtures';
export async function limitField() {
  const section = await screen.findByRole('region', { name: 'Runs at once' });
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
