import { expect } from 'vitest';

export function expectProblem(
  response: Readonly<{
    statusCode: number;
    payload: string;
    headers: Readonly<Record<string, unknown>>;
    json(): unknown;
  }>,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(String(response.headers['content-type'])).toContain(
    'application/problem+json',
  );
  const problem = response.json() as Readonly<Record<string, unknown>>;
  expect(problem).toMatchObject({
    type: `urn:pertexo:problem:${code}`,
    status,
    code,
  });
  expect(problem.title).toEqual(expect.stringMatching(/^\S/u));
  expect(problem.requestId).toEqual(expect.stringMatching(/^\S/u));
}
