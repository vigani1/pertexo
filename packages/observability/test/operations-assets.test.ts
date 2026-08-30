import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const assets = new URL(
  '../../../infrastructure/observability/',
  import.meta.url,
);

describe('operations observability assets', () => {
  it('keeps operational assets linked, semantic, and cardinality-safe', async () => {
    const [
      alerts,
      dashboardText,
      collector,
      prometheus,
      datasource,
      provisioning,
      runbook,
      emitters,
    ] = await Promise.all([
      readFile(new URL('pertexo-alerts.yaml', assets), 'utf8'),
      readFile(new URL('grafana-dashboard.json', assets), 'utf8'),
      readFile(new URL('otel-collector.yaml', assets), 'utf8'),
      readFile(new URL('prometheus.yaml', assets), 'utf8'),
      readFile(new URL('grafana-datasource.yaml', assets), 'utf8'),
      readFile(new URL('grafana-dashboards.yaml', assets), 'utf8'),
      readFile(
        new URL(
          '../../../docs/operations/observability-alerts.md',
          import.meta.url,
        ),
        'utf8',
      ),
      Promise.all(
        [
          '../../../apps/api/src/platform/observability/api-metrics.ts',
          '../../../apps/api/src/platform/observability/sse-visibility-metrics.ts',
          '../../../apps/api/src/webhooks/telemetry.ts',
          '../../../apps/retention/src/metrics.ts',
          '../../../apps/worker/src/execution/http-provider-telemetry.ts',
          '../../../apps/worker/src/execution/coordinator-telemetry.ts',
          '../../../apps/worker/src/triggers/trigger-telemetry.ts',
          '../../artifact-store/src/object-store-telemetry.ts',
          '../../database/src/postgres-telemetry.ts',
          '../../queue/src/redis-telemetry.ts',
          '../src/maintenance-metrics.ts',
          '../src/telemetry.ts',
          '../src/transport-metrics.ts',
        ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
      ).then((sources) => sources.join('\n')),
    ]);

    const dashboard = JSON.parse(dashboardText) as {
      readonly panels: readonly {
        readonly description?: string;
        readonly id: number;
        readonly targets?: readonly { readonly expr?: string }[];
        readonly title: string;
        readonly type: string;
      }[];
    };
    expect(dashboard.panels).toHaveLength(21);
    expect(new Set(dashboard.panels.map(({ id }) => id)).size).toBe(21);
    expect(new Set(dashboard.panels.map(({ title }) => title)).size).toBe(21);
    for (const panel of dashboard.panels) {
      expect(panel.description?.length).toBeGreaterThan(20);
      if (panel.type !== 'text') {
        expect(panel.targets?.length).toBeGreaterThan(0);
        for (const target of panel.targets ?? [])
          expect(target.expr?.trim().length).toBeGreaterThan(0);
      }
    }

    const alertBlocks = alerts.split('\n      - alert: ').slice(1);
    expect(alertBlocks).toHaveLength(24);
    for (const block of alertBlocks) {
      const [alertName = ''] = block.split('\n', 1);
      expect(alertName).toMatch(/^Pertexo[A-Za-z]+$/u);
      expect(block).toContain('summary:');
      expect(block).toContain('description:');
      expect(block).toContain(
        `runbook_url: https://github.com/vigani1/pertexo/blob/main/docs/operations/observability-alerts.md#${alertName.toLowerCase()}`,
      );
      expect(runbook).toContain(`## ${alertName}`);
    }
    for (const group of [
      'pertexo-user-impact',
      'pertexo-durable-backlog',
      'pertexo-resource-safety',
      'pertexo-destructive-maintenance',
    ])
      expect(alerts).toContain(`name: ${group}`);
    expect(alerts).toContain(
      'method=~"POST|PUT|PATCH|DELETE",status_class="2xx"',
    );
    expect(alerts).toContain('alert: PertexoScheduleScanLagHigh');
    expect(alerts).not.toContain('Schedule-to-scan');

    const allowedSeries = new Set([
      'pertexo_api_availability_request_count_total',
      'pertexo_api_request_count_total',
      'pertexo_api_request_duration_seconds_bucket',
      'pertexo_api_sse_persisted_to_visible_duration_seconds_bucket',
      'pertexo_api_sse_persisted_to_visible_skew_count_total',
      'pertexo_control_ledger_reconciliation_count_total',
      'pertexo_database_lock_wait_active',
      'pertexo_database_pool_saturation_ratio',
      'pertexo_database_pool_waiters',
      'pertexo_database_query_duration_seconds_bucket',
      'pertexo_database_transaction_duration_seconds_bucket',
      'pertexo_lifecycle_command_process_count_total',
      'pertexo_maintenance_operator_rerun_count_total',
      'pertexo_object_store_request_count_total',
      'pertexo_object_store_request_duration_seconds_bucket',
      'pertexo_object_store_safety_violation_count_total',
      'pertexo_provider_rate_limit_count_total',
      'pertexo_provider_request_count_total',
      'pertexo_purge_batch_count_total',
      'pertexo_purge_batch_duration_seconds_bucket',
      'pertexo_regional_replica_admission_blocked',
      'pertexo_regional_replica_replay_lag_seconds',
      'pertexo_retention_batch_count_total',
      'pertexo_retention_operation_failure_count_total',
      'pertexo_redis_operation_count_total',
      'pertexo_redis_operation_duration_seconds_bucket',
      'pertexo_redis_connection_event_count_total',
      'pertexo_schedule_lag_seconds_bucket',
      'pertexo_schedule_start_count_total',
      'pertexo_schedule_to_start_duration_seconds_bucket',
      'pertexo_transport_artifact_bytes',
      'pertexo_transport_artifact_count',
      'pertexo_transport_execution_storage_bytes_bucket',
      'pertexo_transport_execution_storage_count_bucket',
      'pertexo_transport_consumer_lifecycle_total',
      'pertexo_transport_handler_executions_total',
      'pertexo_transport_outbox_oldest_age_seconds',
      'pertexo_transport_queue_oldest_job_age_seconds',
      'pertexo_transport_queue_stalls_total',
      'pertexo_trigger_reconciliation_count_total',
      'pertexo_webhook_delivery_count_total',
      'pertexo_webhook_health_count_total',
      'pertexo_worker_process_starts_total',
      'nodejs_eventloop_delay_p99_seconds',
      'process_cpu_utilization',
      'process_memory_usage',
      'v8js_memory_heap_used_bytes',
    ]);
    const referencedSeries = new Set(
      `${alerts}\n${dashboardText}`.match(
        /\b(?:pertexo_[a-z0-9_]+|process_(?:cpu|memory)_[a-z0-9_]+|nodejs_eventloop_[a-z0-9_]+|v8js_memory_[a-z0-9_]+)/gu,
      ) ?? [],
    );
    expect([...referencedSeries].sort()).toEqual([...allowedSeries].sort());
    for (const emittedMetric of [
      'pertexo.api.availability_request.count',
      'pertexo.api.request.count',
      'pertexo.api.request.duration',
      'pertexo.api.sse.persisted_to_visible.duration',
      'pertexo.api.sse.persisted_to_visible.skew.count',
      'pertexo.control_ledger.reconciliation.count',
      'pertexo.database.lock_wait.active',
      'pertexo.database.lock_wait.duration',
      'pertexo.database.pool.connections',
      'pertexo.database.pool.saturation',
      'pertexo.database.pool.waiters',
      'pertexo.database.query.duration',
      'pertexo.database.transaction.duration',
      'pertexo.lifecycle_command.process.count',
      'pertexo.maintenance.operator_rerun.count',
      'pertexo.object_store.request.count',
      'pertexo.object_store.request.duration',
      'pertexo.object_store.safety.violation.count',
      'pertexo.provider.rate_limit.count',
      'pertexo.provider.request.count',
      'pertexo.purge.batch.count',
      'pertexo.purge.batch.duration',
      'pertexo.regional_replica.admission.blocked',
      'pertexo.regional_replica.replay_lag',
      'pertexo.retention.batch.count',
      'pertexo.retention.operation.failure.count',
      'pertexo.redis.connection.event.count',
      'pertexo.redis.operation.count',
      'pertexo.redis.operation.duration',
      'pertexo.schedule.lag',
      'pertexo.schedule.start.count',
      'pertexo.schedule.to_start.duration',
      'pertexo.transport.artifact.bytes',
      'pertexo.transport.artifact.count',
      'pertexo.transport.execution_storage.bytes',
      'pertexo.transport.execution_storage.count',
      'pertexo.transport.consumer.lifecycle',
      'pertexo.transport.handler.executions',
      'pertexo.transport.outbox.oldest_age',
      'pertexo.transport.queue.oldest_job_age',
      'pertexo.transport.queue.stalls',
      'pertexo.trigger.reconciliation.count',
      'pertexo.webhook.delivery.count',
      'pertexo.webhook.health.count',
      'pertexo.worker.process.starts',
    ])
      expect(emitters).toContain(emittedMetric);

    expect(collector).toContain('memory_limiter');
    expect(collector).toContain('resource/drop_process_identity');
    expect(collector).toContain('key: process.pid');
    expect(collector).toContain('key: process.command_args');
    expect(collector).toContain('prometheus:');
    expect(prometheus).toContain('pertexo-alerts.yaml');
    expect(datasource).toContain('http://prometheus:9090');
    expect(provisioning).toContain('/var/lib/grafana/dashboards');
    for (const forbidden of [
      'workspace_id',
      'workflow_id',
      'run_id',
      'attempt_id',
      'request_id',
      'artifact_id',
      'storage_key',
      'endpoint_key',
      'process_pid',
    ]) {
      expect(alerts).not.toContain(forbidden);
      expect(dashboardText).not.toContain(forbidden);
    }
    expect(emitters).toContain("'@opentelemetry/instrumentation-host-metrics'");
    expect(emitters).toContain(
      "metricGroups: ['process.cpu', 'process.memory']",
    );
    expect(emitters).toContain("'@opentelemetry/instrumentation-runtime-node'");
  });
});
