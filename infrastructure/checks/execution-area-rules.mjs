// These are the retained transactional relationships from the execution-area reads.
// A new relationship needs an ownership decision, even for type-only imports.
const allowedDependencies = new Set([
  'artifacts -> runs',
  'artifacts -> triggers',
  'attempts -> connections',
  'attempts -> outbox',
  'attempts -> runs',
  'attempts -> shared',
  'attempts -> variables',
  'authoring -> runs',
  'authoring -> triggers',
  'connections -> outbox',
  'data-tables -> attempts',
  'inbox -> runs',
  'lifecycle -> outbox',
  'lifecycle -> runs',
  'lifecycle -> triggers',
  'notifications -> outbox',
  'operator -> outbox',
  'operator -> attempts',
  'operator -> runs',
  'outbox -> shared',
  'previews -> outbox',
  'previews -> runs',
  'runs -> artifacts',
  'runs -> attempts',
  'runs -> data-tables',
  'runs -> governance',
  'runs -> inbox',
  'runs -> notifications',
  'runs -> outbox',
  'runs -> shared',
  'runs -> triggers',
  'runs -> variables',
  'tenant-access -> outbox',
  'triggers -> artifacts',
  'triggers -> attempts',
  'triggers -> authoring',
  'triggers -> governance',
  'triggers -> outbox',
  'triggers -> runs',
  'triggers -> shared',
  'triggers -> tenant-access',
]);

const coreAreas = new Set(['runs', 'attempts', 'triggers', 'outbox']);
const applicationAreas = {
  api: ['workflow-runs', 'pending-tasks', 'forms', 'schedules', 'webhooks'],
  worker: ['runs', 'attempts', 'triggers', 'transport'],
};

// These completed batch D cuts also cover areas outside the execution cohort.
const removedDependencies = new Set([
  'lifecycle -> tenant-access',
  'authoring -> connections',
]);

export function executionAreaDependencyAllowed(from, to) {
  if (removedDependencies.has(`${from} -> ${to}`)) return false;
  return (
    from === to ||
    (!coreAreas.has(from) && !coreAreas.has(to)) ||
    allowedDependencies.has(`${from} -> ${to}`)
  );
}

export function isExecutionAreaFile(file) {
  const [kind, workspace, lane, area] = file.split('/');
  if (!['src', 'test'].includes(lane)) return false;
  if (kind === 'packages' && workspace === 'core') return coreAreas.has(area);
  return (
    kind === 'apps' && applicationAreas[workspace]?.includes(area) === true
  );
}

export function isExecutionAreaEntry(file) {
  const [kind, workspace, lane, area, name, ...rest] = file.split('/');
  return (
    kind === 'packages' &&
    workspace === 'core' &&
    lane === 'src' &&
    coreAreas.has(area) &&
    name === 'index.ts' &&
    rest.length === 0
  );
}
