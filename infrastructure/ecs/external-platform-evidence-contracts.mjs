function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameMembers(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected))
  );
}

function isArn(value, service) {
  return (
    typeof value === 'string' &&
    new RegExp(`^arn:aws[a-z-]*:${service}:`, 'u').test(value)
  );
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function instant(value, label) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  assert(Number.isFinite(milliseconds), `${label} is invalid`);
  return milliseconds;
}

function assertSource(resource, description) {
  assert(
    resource?.source === 'aws-api',
    `${description} must come from aws-api`,
  );
}

function assertUnique(values, description) {
  assert(
    new Set(values).size === values.length,
    `${description} must be distinct by workload`,
  );
}

function assertRawObservation(observations, id, kind, region, description) {
  const observation = observations.get(id);
  assert(
    observation?.kind === kind && observation.region === region,
    `${description} must reference its ${region} ${kind} raw observation`,
  );
}

function assertCollection(evidence, contract, observedAt) {
  const collection = evidence.collection;
  assert(isRecord(collection), 'deployment evidence collection is missing');
  assert(
    collection.verificationStatus === 'requires-independent-authentication',
    'normalized evidence must not self-attest verified remote state',
  );
  assert(
    isArn(collection.collectorIdentityArn, 'iam'),
    'deployment evidence must identify the collector IAM principal',
  );
  assert(
    typeof collection.runId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(collection.runId),
    'deployment evidence must identify one collection run',
  );
  const startedAt = instant(collection.startedAt, 'collection start time');
  const completedAt = instant(
    collection.completedAt,
    'collection completion time',
  );
  assert(
    startedAt <= completedAt && completedAt <= observedAt,
    'collection times must precede the normalized observation time',
  );
  assert(
    Array.isArray(collection.rawObservations) &&
      collection.rawObservations.length > 0,
    'deployment evidence must reference raw observations',
  );
  const observations = new Map();
  const coverage = [];
  const allowedKinds = [
    ...contract.evidence.requiredRawObservationKinds,
    ...contract.evidence.requiredRecoveryRawObservationKinds,
  ];
  for (const raw of collection.rawObservations) {
    assertSource(raw, 'raw observation');
    assert(
      typeof raw.id === 'string' &&
        raw.id.length > 0 &&
        !observations.has(raw.id),
      'raw observation IDs must be nonempty and distinct',
    );
    assert(
      [contract.primaryRegion, contract.recoveryRegion].includes(raw.region) &&
        allowedKinds.includes(raw.kind),
      'raw observation kind or region is outside the reviewed contract',
    );
    assert(
      typeof raw.reference === 'string' &&
        raw.reference.length > 0 &&
        !/\s/u.test(raw.reference),
      'raw observation reference is invalid',
    );
    assert(isSha256(raw.sha256), 'raw observation must have an exact SHA-256');
    observations.set(raw.id, raw);
    coverage.push(`${raw.region}:${raw.kind}`);
  }
  const requiredCoverage = [
    contract.primaryRegion,
    contract.recoveryRegion,
  ].flatMap((region) =>
    contract.evidence.requiredRawObservationKinds.map(
      (kind) => `${region}:${kind}`,
    ),
  );
  requiredCoverage.push(
    ...contract.evidence.requiredRecoveryRawObservationKinds.map(
      (kind) => `${contract.recoveryRegion}:${kind}`,
    ),
  );
  assert(
    sameMembers(coverage, requiredCoverage),
    'raw observation coverage must exactly match the reviewed contract',
  );
  return observations;
}

function assertRole(role, description, contract, observations, region) {
  assertSource(role, description);
  assert(isArn(role.arn, 'iam'), `${description} must have an IAM ARN`);
  assert(isSha256(role.policySha256), `${description} must hash its policy`);
  assertRawObservation(
    observations,
    role.rawObservationId,
    'iam',
    region,
    description,
  );
  assert(
    !contract.evidence.forbidWildcardIamActions ||
      role.hasWildcardAction === false,
    `${description} must not contain wildcard actions`,
  );
  assert(
    !contract.evidence.forbidSensitiveResourceWildcards ||
      role.hasSensitiveWildcardResource === false,
    `${description} must not contain wildcard sensitive resources`,
  );
}

function assertNetwork(regionEvidence, region, contract, observations) {
  const network = regionEvidence.network;
  assertSource(network, `${region} network`);
  assertRawObservation(
    observations,
    network.rawObservationId,
    'ec2-network',
    region,
    `${region} network`,
  );
  assert(
    network.assignPublicIp === contract.network.assignPublicIp,
    `${region} tasks must not receive public IPs`,
  );
  assert(
    sameMembers(
      network.reachableRegionalEndpoints,
      contract.network.requiredRegionalEndpoints,
    ),
    `${region} regional endpoint reachability drifted`,
  );
  assert(
    isRecord(network.egressByWorkload) &&
      sameMembers(
        Object.keys(network.egressByWorkload),
        Object.keys(contract.network.egressByWorkload),
      ) &&
      Object.entries(contract.network.egressByWorkload).every(
        ([name, expected]) =>
          sameMembers(network.egressByWorkload[name], expected),
      ),
    `${region} workload egress policy drifted`,
  );
  for (const [values, expression, label] of [
    [network.securityGroupIds, /^sg-[a-f0-9]+$/u, 'security groups'],
    [network.subnetIds, /^subnet-[a-f0-9]+$/u, 'subnets'],
  ])
    assert(
      Array.isArray(values) &&
        values.length > 0 &&
        values.every((value) => expression.test(value)),
      `${region} must report concrete ${label}`,
    );
  assert(
    isSha256(network.routeAndSecurityGroupPolicySha256),
    `${region} must hash normalized route and security-group policy`,
  );
  if (region === contract.primaryRegion)
    assert(
      Array.isArray(network.availabilityZones) &&
        new Set(network.availabilityZones).size >=
          contract.network.minimumPrimaryAvailabilityZones &&
        Array.isArray(network.publicIngress) &&
        network.publicIngress.length === 1 &&
        network.publicIngress[0].workload ===
          contract.network.publicIngress.workload &&
        network.publicIngress[0].containerPort ===
          contract.network.publicIngress.containerPort &&
        network.publicIngress[0].sourceClass ===
          contract.network.publicIngress.sourceClass &&
        Array.isArray(network.publicIngress[0].sourceSecurityGroupIds) &&
        network.publicIngress[0].sourceSecurityGroupIds.length > 0 &&
        network.publicIngress[0].sourceSecurityGroupIds.every((id) =>
          /^sg-[a-f0-9]+$/u.test(id),
        ),
      `${region} public ingress must be limited to the trusted API ingress`,
    );
  else
    assert(
      Array.isArray(network.publicIngress) &&
        network.publicIngress.length === 0,
      `${region} recovery ingress must remain closed`,
    );
}

function assertInjectionEvidence(actual, expectedNames, options) {
  const { description, observations, region, service } = options;
  assert(
    Array.isArray(actual) &&
      sameMembers(
        actual.map((entry) => entry?.name),
        expectedNames,
      ),
    `${description} references drifted from workloads.json`,
  );
  for (const entry of actual) {
    assertSource(entry, `${description} ${entry.name}`);
    assert(
      isArn(entry.arn, service),
      `${description} ${entry.name} must have an AWS ARN`,
    );
    assertRawObservation(
      observations,
      entry.rawObservationId,
      service === 'ssm' ? 'ssm' : 'secrets-manager',
      region,
      `${description} ${entry.name}`,
    );
    assert(
      entry.executionRoleCanRead === true,
      `${description} ${entry.name} must prove execution-role read permission`,
    );
    if (service === 'secretsmanager') {
      assert(
        isArn(entry.kmsKeyArn, 'kms'),
        `${description} ${entry.name} must identify its KMS key`,
      );
      assertRawObservation(
        observations,
        entry.kmsRawObservationId,
        'kms',
        region,
        `${description} ${entry.name} KMS key`,
      );
      assert(
        entry.executionRoleCanDecrypt === true,
        `${description} ${entry.name} must prove execution-role KMS permission`,
      );
    }
  }
}

function assertService(actual, workload, name, region, contract, observations) {
  const service = actual.service;
  assertSource(service, `${region} ${name} service`);
  assertRawObservation(
    observations,
    service.rawObservationId,
    'ecs',
    region,
    `${region} ${name} service`,
  );
  assert(
    service.desiredCount === workload.desiredCount[region],
    `${region} ${name} desired count drifted`,
  );
  assert(
    service.minimumHealthyPercent === contract.services.minimumHealthyPercent &&
      service.maximumPercent === contract.services.maximumPercent &&
      service.healthCheckGracePeriodSeconds ===
        contract.services.healthCheckGracePeriodSeconds &&
      service.drainSeconds === contract.services.drainSeconds,
    `${region} ${name} rollout or drain policy drifted`,
  );
  assert(
    service.deploymentStatus === 'COMPLETED' &&
      service.runningCount === service.desiredCount &&
      service.pendingCount === 0,
    `${region} ${name} deployment is not healthy`,
  );
}

function assertTelemetry(actual, name, region, contract, observations) {
  if (!contract.telemetry.requiredWorkloads.includes(name)) return;
  const telemetry = actual.telemetry;
  assertSource(telemetry, `${region} ${name} telemetry`);
  assertRawObservation(
    observations,
    telemetry.rawObservationId,
    'cloudwatch',
    region,
    `${region} ${name} telemetry`,
  );
  assert(
    !contract.telemetry.requireMetricPublication ||
      (Array.isArray(telemetry.publishedMetricNames) &&
        telemetry.publishedMetricNames.length > 0),
    `${name} must prove metric publication`,
  );
  assert(
    !contract.telemetry.requireAlarmActions ||
      (Array.isArray(telemetry.alarmArns) &&
        telemetry.alarmArns.length > 0 &&
        telemetry.alarmArns.every((arn) => isArn(arn, 'cloudwatch')) &&
        telemetry.alarmActionsEnabled === true),
    `${name} must prove enabled alarm wiring`,
  );
}

function assertAutoscaling(regionEvidence, region, autoscaling, observations) {
  for (const [name, expected] of Object.entries(autoscaling.services)) {
    const actual = regionEvidence.autoscaling[name];
    assertSource(actual, `${region} ${name} autoscaling`);
    assertRawObservation(
      observations,
      actual.rawObservationId,
      'application-autoscaling',
      region,
      `${region} ${name} autoscaling`,
    );
    assertRawObservation(
      observations,
      actual.alarmRawObservationId,
      'cloudwatch',
      region,
      `${region} ${name} autoscaling alarms`,
    );
    assert(
      actual.resourceId === `service/pertexo/${name}` &&
        actual.minCapacity === expected.capacity[region].min &&
        actual.maxCapacity === expected.capacity[region].max,
      `${region} ${name} scaling target drifted`,
    );
    assert(
      actual.scaleOutCooldownSeconds === expected.scaleOutCooldownSeconds &&
        actual.scaleInCooldownSeconds === expected.scaleInCooldownSeconds &&
        actual.configuredSlotsPerTask ===
          (expected.configuredSlotsPerTask ?? null),
      `${region} ${name} scaling cooldown or capacity normalization drifted`,
    );
    assert(
      Array.isArray(actual.policies) &&
        sameMembers(
          actual.policies.map((policy) => policy?.signal),
          expected.signals.map((signal) => signal.name),
        ),
      `${region} ${name} scaling policy inventory drifted`,
    );
    for (const signal of expected.signals) {
      const policy = actual.policies.find(
        (entry) => entry.signal === signal.name,
      );
      assert(
        policy.metric === signal.metric &&
          policy.statistic === signal.statistic &&
          policy.threshold === signal.threshold &&
          policy.unit === signal.unit &&
          policy.periodSeconds === signal.periodSeconds &&
          policy.evaluationPeriods === signal.evaluationPeriods &&
          policy.normalization === (signal.normalization ?? null) &&
          isArn(policy.alarmArn, 'cloudwatch') &&
          policy.enabled === true,
        `${region} ${name} ${signal.name} scaling policy drifted`,
      );
    }
  }
}

function assertMigration(evidence, contract, primaryWorkloads, observations) {
  const migration = evidence.migration;
  assertSource(migration, 'migration execution');
  assertRawObservation(
    observations,
    migration.rawObservationId,
    'ecs',
    contract.primaryRegion,
    'migration execution',
  );
  assert(
    migration.workload === contract.migration.workload &&
      migration.exitCode === 0 &&
      Number.isSafeInteger(migration.maximumObservedConcurrentTasks) &&
      migration.maximumObservedConcurrentTasks >= 1 &&
      migration.maximumObservedConcurrentTasks <=
        contract.migration.maximumConcurrentTasks,
    'migration execution was unsuccessful or non-exclusive',
  );
  const startedAt = instant(migration.startedAt, 'migration start time');
  const stoppedAt = instant(migration.stoppedAt, 'migration stop time');
  const servicesUpdatedAt = instant(
    migration.servicesUpdatedAt,
    'serving service update time',
  );
  assert(
    startedAt <= stoppedAt &&
      (!contract.migration.mustCompleteBeforeServiceUpdate ||
        stoppedAt <= servicesUpdatedAt),
    'serving services were updated before migration completed',
  );
  assert(
    isArn(migration.taskArn, 'ecs') &&
      isArn(migration.taskDefinitionArn, 'ecs') &&
      migration.taskDefinitionArn ===
        primaryWorkloads[contract.migration.workload].taskDefinitionArn &&
      Array.isArray(migration.successfulTaskArns) &&
      migration.successfulTaskArns.length === 1 &&
      migration.successfulTaskArns[0] === migration.taskArn,
    'migration must bind its one successful task to the observed workload',
  );
}

function assertRecoveryWriterFence(evidence, contract, observations) {
  const fence = evidence.recoveryWriterFence;
  assertSource(fence, 'recovery writer fence');
  for (const [id, kind] of [
    [fence.ecsRawObservationId, 'ecs'],
    [fence.networkRawObservationId, 'ec2-network'],
    [fence.routeRawObservationId, 'route53'],
    [fence.loadBalancerRawObservationId, 'elastic-load-balancing-v2'],
    [fence.eventBridgeRawObservationId, 'eventbridge'],
    [fence.queueRawObservationId, 'sqs'],
  ])
    assertRawObservation(
      observations,
      id,
      kind,
      contract.recoveryRegion,
      'recovery writer fence',
    );
  assert(
    fence.region === contract.recoveryWriterFence.region &&
      fence.ingressClosed ===
        contract.recoveryWriterFence.requiredClosedIngress,
    'recovery writer ingress fence is not closed',
  );
  assert(
    isRecord(fence.writerDesiredCounts) &&
      sameMembers(
        Object.keys(fence.writerDesiredCounts),
        contract.recoveryWriterFence.writerWorkloads,
      ) &&
      Object.values(fence.writerDesiredCounts).every(
        (count) =>
          count === contract.recoveryWriterFence.requiredWriterDesiredCount,
      ),
    'recovery writer desired-count fence is not closed',
  );
  assert(
    isSha256(fence.routeAndQueuePolicySha256),
    'recovery writer fence must hash route and queue policy state',
  );
}

function assertFingerprints(evidence, fingerprints) {
  const actual = evidence.contractFingerprints;
  assert(
    isRecord(actual) &&
      Object.keys(fingerprints).every(
        (name) => isSha256(actual[name]) && actual[name] === fingerprints[name],
      ) &&
      sameMembers(Object.keys(actual), Object.keys(fingerprints)),
    'deployment evidence does not match all reviewed deployment contracts',
  );
}

export function validateEvidenceAgainstContracts(
  evidence,
  { autoscaling, contract, fingerprints, now, workloads },
) {
  assert(contract.schemaVersion === 1, 'unsupported platform contract version');
  assert(
    evidence?.schemaVersion === contract.evidence.normalizedSchemaVersion,
    'unsupported evidence schema version',
  );
  assert(
    evidence.source === contract.evidence.source,
    'deployment evidence must describe normalized AWS API observations',
  );
  assertFingerprints(evidence, fingerprints);
  assert(
    /^[a-f0-9]{40}$/u.test(evidence.release?.commitSha),
    'deployment evidence must identify an exact Git commit',
  );
  assert(
    !contract.evidence.requireImmutableImage ||
      /^[^\s]+@sha256:[a-f0-9]{64}$/u.test(evidence.release?.imageUri),
    'deployment evidence must identify a digest-qualified image',
  );
  const observedAt = instant(evidence.observedAt, 'deployment evidence time');
  assert(
    now.getTime() - observedAt >= 0 &&
      now.getTime() - observedAt <=
        contract.evidence.maximumAgeMinutes * 60_000,
    'deployment evidence is stale or from the future',
  );
  const observations = assertCollection(evidence, contract, observedAt);
  assert(
    isRecord(evidence.release.imageRawObservationIds) &&
      sameMembers(Object.keys(evidence.release.imageRawObservationIds), [
        contract.primaryRegion,
        contract.recoveryRegion,
      ]),
    'release image evidence must cover both deployment regions',
  );
  for (const region of [contract.primaryRegion, contract.recoveryRegion])
    assertRawObservation(
      observations,
      evidence.release.imageRawObservationIds[region],
      'ecr',
      region,
      'release image',
    );

  for (const region of [contract.primaryRegion, contract.recoveryRegion]) {
    const regionEvidence = evidence.regions?.[region];
    assert(regionEvidence, `missing ${region} deployment evidence`);
    assertNetwork(regionEvidence, region, contract, observations);
    assert(
      isRecord(regionEvidence.workloads) &&
        sameMembers(
          Object.keys(regionEvidence.workloads),
          Object.keys(workloads.workloads),
        ),
      `${region} workload inventory drifted`,
    );
    const taskRoles = [];
    const executionRoles = [];
    for (const [name, workload] of Object.entries(workloads.workloads)) {
      const actual = regionEvidence.workloads[name];
      assertSource(actual, `${region} ${name} workload`);
      assertRawObservation(
        observations,
        actual.rawObservationId,
        'ecs',
        region,
        `${region} ${name} workload`,
      );
      assert(
        isArn(actual.taskDefinitionArn, 'ecs'),
        `${region} ${name} must identify its task definition`,
      );
      assert(
        actual.imageUri === evidence.release.imageUri,
        `${region} ${name} image drifted from the release`,
      );
      assertRole(
        actual.taskRole,
        `${region} ${name} task role`,
        contract,
        observations,
        region,
      );
      assertRole(
        actual.executionRole,
        `${region} ${name} execution role`,
        contract,
        observations,
        region,
      );
      taskRoles.push(actual.taskRole.arn);
      executionRoles.push(actual.executionRole.arn);
      assertInjectionEvidence(
        actual.configurationReferences,
        workload.configuration,
        {
          description: `${region} ${name} configuration`,
          observations,
          region,
          service: 'ssm',
        },
      );
      assertInjectionEvidence(actual.secretReferences, workload.secrets, {
        description: `${region} ${name} secret`,
        observations,
        region,
        service: 'secretsmanager',
      });
      if (workload.kind === 'service')
        assertService(actual, workload, name, region, contract, observations);
      assertTelemetry(actual, name, region, contract, observations);
    }
    if (contract.evidence.requireDistinctTaskRoles)
      assertUnique(taskRoles, `${region} task roles`);
    if (contract.evidence.requireDistinctExecutionRoles)
      assertUnique(executionRoles, `${region} execution roles`);
    assert(
      isRecord(regionEvidence.autoscaling) &&
        sameMembers(
          Object.keys(regionEvidence.autoscaling),
          Object.keys(autoscaling.services),
        ),
      `${region} autoscaling inventory drifted`,
    );
    assertAutoscaling(regionEvidence, region, autoscaling, observations);
  }
  assertMigration(
    evidence,
    contract,
    evidence.regions[contract.primaryRegion].workloads,
    observations,
  );
  assertRecoveryWriterFence(evidence, contract, observations);
}
