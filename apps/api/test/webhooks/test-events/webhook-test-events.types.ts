import type { Pool, QueryResultRow, QueryResult } from 'pg';
import type { WorkflowAuthoringStore } from '@pertexo/core/authoring';
import type {
  WebhookTestEventStore,
  TestEventScope,
} from '@pertexo/core/triggers';
import type { WebhookIngressDependencies } from '../../../src/webhooks/ingress/register.js';
import type { HttpSessionCookies } from '../support/browser-session.fixture.js';

export interface Fixture {
  origin: string;
  scope: TestEventScope;
  revision: number;
  session: HttpSessionCookies;
  store: WebhookTestEventStore;
  ingress: WebhookIngressDependencies;
  authoring: WorkflowAuthoringStore;
  apiPool: Pool;
  issueSession: (userId: string) => Promise<HttpSessionCookies>;
  query: <Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ) => Promise<QueryResult<Row>>;
}
