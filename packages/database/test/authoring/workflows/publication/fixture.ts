export function recordBenchmarkOperation(
  name: string,
  startedAt: number,
): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION=${JSON.stringify({ name, startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population: 1, boundary: name === 'workflow-create' ? 'createWorkflow call through durable returned result' : 'publishWorkflow call with precomputed representation tag through durable returned result' })}\n`,
  );
}
