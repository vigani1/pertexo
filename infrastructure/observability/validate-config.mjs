import { log } from 'node:console';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

import { parseDocument } from 'yaml';

const assets = new URL('./', import.meta.url);

function fail(message) {
  throw new Error(`Observability configuration is invalid: ${message}`);
}

async function yaml(name) {
  const document = parseDocument(
    await readFile(new URL(name, assets), 'utf8'),
    {
      prettyErrors: true,
      strict: true,
      uniqueKeys: true,
    },
  );
  if (document.errors.length > 0)
    fail(`${name}: ${document.errors[0].message}`);
  return document.toJS({ maxAliasCount: 0 });
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

const collector = record(await yaml('otel-collector.yaml'), 'collector');
const service = record(collector.service, 'collector.service');
const pipelines = record(service.pipelines, 'collector.service.pipelines');
for (const pipeline of ['metrics', 'traces']) {
  const definition = record(
    pipelines[pipeline],
    `collector pipeline ${pipeline}`,
  );
  for (const field of ['receivers', 'processors', 'exporters']) {
    if (!Array.isArray(definition[field]) || definition[field].length === 0)
      fail(`collector ${pipeline}.${field} must be a non-empty list`);
  }
}

const datasource = record(
  await yaml('grafana-datasource.yaml'),
  'Grafana datasource provisioning',
);
if (datasource.apiVersion !== 1 || !Array.isArray(datasource.datasources))
  fail('Grafana datasource provisioning must use apiVersion 1 and datasources');
if (
  !datasource.datasources.some(
    (entry) => record(entry, 'Grafana datasource').type === 'prometheus',
  )
)
  fail('Grafana must provision a Prometheus datasource');

const dashboards = record(
  await yaml('grafana-dashboards.yaml'),
  'Grafana dashboard provisioning',
);
if (dashboards.apiVersion !== 1 || !Array.isArray(dashboards.providers))
  fail('Grafana dashboard provisioning must use apiVersion 1 and providers');

const dashboard = record(
  JSON.parse(await readFile(new URL('grafana-dashboard.json', assets), 'utf8')),
  'Grafana dashboard',
);
if (!Array.isArray(dashboard.panels) || dashboard.panels.length === 0)
  fail('Grafana dashboard must contain panels');

log('Observability YAML and Grafana structure are valid.');
