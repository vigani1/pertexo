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
          '../../../apps/api/src/webhooks/telemetry.ts',
          '../../../apps/retention/src/metrics.ts',
          '../../../apps/worker/src/execution/http-provider-telemetry.ts',
          '../../../apps/worker/src/triggers/trigger-telemetry.ts',
          '../src/maintenance-metrics.ts',
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
    expect(dashboard.panels).toHaveLength(15);
    expect(new Set(dashboard.panels.map(({ id }) => id)).size).toBe(15);
    expect(new Set(dashboard.panels.map(({ title }) => title)).size).toBe(15);
    for (const panel of dashboard.panels) {
      expect(panel.description?.length).toBeGreaterThan(20);
      if (panel.type !== 'text') {
        expect(panel.targets?.length).toBeGreaterThan(0);
        for (const target of panel.targets ?? [])
          expect(target.expr?.trim().length).toBeGreaterThan(0);
      }
    }

    const alertBlocks = alerts.split('\n      - alert: ').slice(1);
    expect(alertBlocks).toHaveLength(15);
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
      'pertexo_control_ledger_reconciliation_count_total',
      'pertexo_lifecycle_command_process_count_total',
      'pertexo_maintenance_operator_rerun_count_total',
      'pertexo_provider_rate_limit_count_total',
      'pertexo_provider_request_count_total',
      'pertexo_purge_batch_count_total',
      'pertexo_purge_batch_duration_seconds_bucket',
      'pertexo_retention_batch_count_total',
      'pertexo_retention_operation_failure_count_total',
      'pertexo_schedule_lag_seconds_bucket',
      'pertexo_transport_artifact_bytes',
      'pertexo_transport_artifact_count',
      'pertexo_transport_consumer_lifecycle_total',
      'pertexo_transport_handler_executions_total',
      'pertexo_transport_outbox_oldest_age_seconds',
      'pertexo_transport_queue_oldest_job_age_seconds',
      'pertexo_transport_queue_stalls_total',
      'pertexo_trigger_reconciliation_count_total',
      'pertexo_webhook_delivery_count_total',
      'pertexo_webhook_health_count_total',
      'pertexo_worker_process_starts_total',
    ]);
    const referencedSeries = new Set(
      `${alerts}\n${dashboardText}`.match(/\bpertexo_[a-z0-9_]+/gu) ?? [],
    );
    expect([...referencedSeries].sort()).toEqual([...allowedSeries].sort());
    for (const emittedMetric of [
      'pertexo.api.availability_request.count',
      'pertexo.api.request.count',
      'pertexo.api.request.duration',
      'pertexo.control_ledger.reconciliation.count',
      'pertexo.lifecycle_command.process.count',
      'pertexo.maintenance.operator_rerun.count',
      'pertexo.provider.rate_limit.count',
      'pertexo.provider.request.count',
      'pertexo.purge.batch.count',
      'pertexo.purge.batch.duration',
      'pertexo.retention.batch.count',
      'pertexo.retention.operation.failure.count',
      'pertexo.schedule.lag',
      'pertexo.transport.artifact.bytes',
      'pertexo.transport.artifact.count',
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
    ]) {
      expect(alerts).not.toContain(forbidden);
      expect(dashboardText).not.toContain(forbidden);
    }
    for (const unsupportedPrefix of [
      'pertexo_postgresql_',
      'pertexo_redis_',
      'pertexo_object_store_',
      'pertexo_worker_rss_',
    ])
      expect(`${alerts}\n${dashboardText}`).not.toContain(unsupportedPrefix);
  });
});
