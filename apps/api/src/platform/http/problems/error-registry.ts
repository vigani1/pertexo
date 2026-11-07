import type { ApplicationError } from '../application-error.js';

type ErrorProjection = (error: unknown) => ApplicationError | undefined;
type ErrorRegistration = readonly [
  abstract new (...args: never[]) => Error,
  ErrorProjection,
];

export function errorRegistration<T extends Error>(
  kind: abstract new (...args: never[]) => T,
  project: (error: T) => ApplicationError | undefined,
): ErrorRegistration {
  return [
    kind,
    (error) => (error instanceof kind ? project(error) : undefined),
  ];
}

export function createErrorRegistry(
  registrations: readonly ErrorRegistration[],
) {
  const projections = new Map<unknown, ErrorProjection>();
  for (const [kind, project] of registrations) {
    if (projections.has(kind))
      throw new Error(`Duplicate problem registration for ${kind.name}`);
    projections.set(kind, project);
  }

  return (error: unknown): ApplicationError | undefined => {
    if (!(error instanceof Error)) return undefined;
    let prototype: unknown = error;
    while (typeof prototype === 'object' && prototype !== null) {
      const kind: unknown = Object.getOwnPropertyDescriptor(
        prototype,
        'constructor',
      )?.value;
      const project =
        typeof kind === 'function' ? projections.get(kind) : undefined;
      if (project !== undefined) {
        const problem = project(error);
        if (problem !== undefined) return problem;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    return undefined;
  };
}
