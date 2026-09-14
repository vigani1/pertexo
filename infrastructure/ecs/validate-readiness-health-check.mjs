function markerPath(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\/[A-Za-z0-9._/-]+$/u.test(value) ||
    value.split('/').includes('..')
  )
    throw new Error(`${label} must be a literal absolute marker path`);
  return value;
}

export function readinessHealthCheckCommand(contract, processId = 1) {
  if (!Number.isSafeInteger(processId) || processId < 1)
    throw new Error('readiness process ID must be a positive safe integer');
  const clauses = [
    `test -f ${markerPath(contract.ready, 'ready marker')}`,
    ...(contract.notReady === undefined
      ? []
      : [`test ! -f ${markerPath(contract.notReady, 'not-ready marker')}`]),
    `kill -0 ${String(processId)}`,
  ];
  return clauses.join(' && ');
}

export function validateReadinessHealthCheck(name, healthCheck, contract) {
  const expected = ['CMD-SHELL', readinessHealthCheckCommand(contract)];
  if (
    !Array.isArray(healthCheck) ||
    JSON.stringify(healthCheck) !== JSON.stringify(expected)
  )
    throw new Error(`${name} health check must equal its readiness contract`);
}
