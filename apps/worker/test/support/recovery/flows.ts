import { httpChain, type HttpStep } from './graphs.js';
import type { Stack } from './stack.js';

/** Publishes a workflow of these steps and starts one run; returns the run id. */
export async function startFlow(
  stack: Stack,
  workspaceId: string,
  name: string,
  flow: readonly HttpStep[] | ReturnType<typeof httpChain>,
): Promise<string> {
  const workflowId = await stack.api.publish(
    workspaceId,
    name,
    'nodes' in flow ? flow : httpChain(flow),
  );
  return stack.api.startRun(workspaceId, workflowId);
}

/** A step the provider never answers the first time, and answers at once after. */
export const heldStep = (
  stack: Stack,
  id: string,
  method: 'GET' | 'POST',
): HttpStep => ({
  id: 'held',
  method,
  url: `${stack.sink.origin}/hold-first/${id}`,
});

/** A step the provider answers after this many seconds. */
export const slowStep = (
  stack: Stack,
  id: string,
  method: 'GET' | 'POST',
  seconds: number,
): HttpStep => ({
  id: 'slow',
  method,
  url: `${stack.sink.origin}/hold/${String(seconds)}/${id}`,
});

/** A step the provider refuses, which fails the run. */
export const failingStep = (stack: Stack, id: string): HttpStep => ({
  id: 'failing',
  method: 'POST',
  url: `${stack.sink.origin}/fail/${id}`,
});

/** The step after: the provider sees it only if the run really moved on. */
export const nextStep = (stack: Stack, id: string): HttpStep => ({
  id: 'next',
  method: 'POST',
  url: `${stack.sink.origin}/ok/${id}`,
});
