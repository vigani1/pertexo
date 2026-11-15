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
    'connections',
    'data-tables',
    'notifications',
    'workspaces',
    'workspace-variables',
    'catalog',
    'authentication',
    'authorization',
    'identity',
    'api-tokens',
    'platform',
    'problems',
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
};

const runtimeApplications = new Set(['worker', 'code-runner', 'ops', 'cli']);

export function isRuntimeApplicationFile(file) {
  const [kind, workspace, lane] = file.split('/');
  return (
    kind === 'apps' &&
    runtimeApplications.has(workspace) &&
    ['src', 'test', 'native', 'python'].includes(lane)
  );
}

export function isExecutionAreaFile(file) {
  const [kind, workspace, lane, area] = file.split('/');
  if (kind === 'infrastructure' || isRuntimeApplicationFile(file)) return true;
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
  if (file === 'apps/api/src/platform/http/index.ts') return true;
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
      [
        'artifacts',
        'catalog',
        'connections',
        'workspaces',
        'node-testing',
        'workflow-authoring',
        'authentication',
        'authorization',
        'identity',
      ].includes(area))
  );
}
