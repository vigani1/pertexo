import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const assets = new URL(
  '../../../infrastructure/observability/',
  import.meta.url,
);

describe('operations observability assets', () => {
  it('keeps alert and dashboard dimensions cardinality-safe', async () => {
    const [alerts, dashboard, collector, prometheus, datasource, provisioning] =
      await Promise.all([
        readFile(new URL('pertexo-alerts.yaml', assets), 'utf8'),
        readFile(new URL('grafana-dashboard.json', assets), 'utf8'),
        readFile(new URL('otel-collector.yaml', assets), 'utf8'),
        readFile(new URL('prometheus.yaml', assets), 'utf8'),
        readFile(new URL('grafana-datasource.yaml', assets), 'utf8'),
        readFile(new URL('grafana-dashboards.yaml', assets), 'utf8'),
      ]);

    expect(() => JSON.parse(dashboard)).not.toThrow();
    expect(alerts).toContain('PertexoApiEligibleErrorBudgetBurn');
    expect(alerts).toContain('PertexoControlLedgerDivergence');
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
      expect(dashboard).not.toContain(forbidden);
    }
  });
});
