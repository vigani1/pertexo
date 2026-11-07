// Retained relationships from the batch C and D reads. Shared enforcement,
// transactional joins and deliberate application composition remain explicit.
// A new relationship needs an ownership decision, even for type-only imports.
const allowedDependencies = new Set([
  // Batch E: retained authority, storage and transactional relationships.
  'connections -> shared',
  'data-tables -> shared',
  'identity -> shared',
  'inbox -> notifications',
  'inbox -> shared',
  'notifications -> connections',
  'notifications -> shared',
  'operator -> shared',
  'tenant-access -> shared',
  'variables -> shared',

  'artifacts -> runs',
  'artifacts -> shared',
  'artifacts -> triggers',
  'attempts -> connections',
  'attempts -> outbox',
  'attempts -> runs',
  'attempts -> shared',
  'attempts -> variables',
  'authoring -> artifacts',
  'authoring -> data-tables',
  'authoring -> governance',
  'authoring -> runs',
  'authoring -> shared',
  'authoring -> tenant-access',
  'authoring -> triggers',
  'authoring -> variables',
  'connections -> governance',
  'connections -> outbox',
  'data-tables -> attempts',
  'data-tables -> governance',
  'governance -> previews',
  'governance -> shared',
  'identity -> governance',
  'inbox -> authoring',
  'inbox -> runs',
  'lifecycle -> artifacts',
  'lifecycle -> connections',
  'lifecycle -> governance',
  'lifecycle -> identity',
  'lifecycle -> inbox',
  'lifecycle -> outbox',
  'lifecycle -> previews',
  'lifecycle -> runs',
  'lifecycle -> shared',
  'lifecycle -> triggers',
  'lifecycle -> variables',
  'notifications -> governance',
  'notifications -> outbox',
  'operator -> attempts',
  'operator -> governance',
  'operator -> outbox',
  'operator -> runs',
  'outbox -> shared',
  'previews -> artifacts',
  'previews -> authoring',
  'previews -> connections',
  'previews -> governance',
  'previews -> outbox',
  'previews -> runs',
  'previews -> shared',
  'previews -> variables',
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
  'tenant-access -> governance',
  'tenant-access -> outbox',
  'triggers -> artifacts',
  'triggers -> attempts',
  'triggers -> authoring',
  'triggers -> governance',
  'triggers -> outbox',
  'triggers -> runs',
  'triggers -> shared',
  'triggers -> tenant-access',
  'variables -> governance',
]);

const coreAreas = new Set([
  'inbox',
  'notifications',
  'data-tables',
  'operator',
  'variables',
  'shared',
  'runs',
  'attempts',
  'triggers',
  'outbox',
  'authoring',
  'lifecycle',
  'governance',
  'artifacts',
  'previews',
]);
const applicationAreas = {
  api: [
    'workflow-runs',
    'pending-tasks',
    'forms',
    'schedules',
    'webhooks',
    'workflow-authoring',
    'node-testing',
    'governance',
    'artifacts',
  ],
  worker: [
    'runs',
    'attempts',
    'triggers',
    'transport',
    'previews',
    'retention',
  ],
};

// These completed batch D cuts also cover areas outside the execution cohort.
const removedDependencies = new Set([
  'lifecycle -> tenant-access',
  'authoring -> connections',
  'authoring -> previews',
  'previews -> tenant-access',
  'tenant-access -> lifecycle',
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
  if (kind === 'infrastructure') return true;
  if (!['src', 'test'].includes(lane)) return false;
  if (
    kind === 'packages' &&
    [
      'contracts',
      'workflow-engine',
      'workflow-model',
      'node-sdk',
      'nodes-core',
      'node-catalog',
      'templates',
      'integrations',
    ].includes(workspace)
  )
    return true;
  if (kind === 'packages' && workspace === 'core') return coreAreas.has(area);
  return (
    kind === 'apps' && applicationAreas[workspace]?.includes(area) === true
  );
}

export function isExecutionAreaEntry(file) {
  const [kind, workspace, lane, area, name, ...rest] = file.split('/');
  if (
    kind === 'packages' &&
    [
      'contracts',
      'workflow-engine',
      'workflow-model',
      'node-sdk',
      'nodes-core',
      'node-catalog',
      'templates',
      'integrations',
    ].includes(workspace) &&
    lane === 'src' &&
    name === undefined
  )
    return ['index.ts', 'server.ts'].includes(area);
  if (name !== 'index.ts' || rest.length !== 0 || lane !== 'src') return false;
  return (
    (kind === 'packages' && workspace === 'core' && coreAreas.has(area)) ||
    (kind === 'apps' &&
      workspace === 'api' &&
      ['artifacts', 'node-testing', 'workflow-authoring'].includes(area))
  );
}
