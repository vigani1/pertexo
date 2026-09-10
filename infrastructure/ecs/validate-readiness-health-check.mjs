export function validateReadinessHealthCheck(name, healthCheck, contract) {
  const command = healthCheck.join(' ');
  if (!command.includes(`test -f ${contract.ready}`))
    throw new Error(`${name} health check must require its readiness marker`);
  if (
    contract.notReady !== undefined &&
    !command.includes(`test ! -f ${contract.notReady}`)
  )
    throw new Error(
      `${name} health check must reject its readiness-revocation marker`,
    );
}
