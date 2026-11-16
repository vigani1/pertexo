/** Recovery tests stop services: an explicit disposable project is mandatory. */
export function faultProject(environment = process.env) {
  const project = environment.COMPOSE_PROJECT_NAME?.trim();
  if (!project || project === 'pertexo')
    throw new Error(
      'Recovery tests require COMPOSE_PROJECT_NAME for a disposable stack; never pertexo.',
    );
  return project;
}
