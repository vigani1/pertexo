import { afterAll, beforeAll, describe } from 'vitest';

import { schedule, beforeAllFixture1 } from './triggers-part-2/fixture.js';
import { registerDeduplicatesOccurrencePreservesSaturatedOccurrence } from './triggers-part-2/deduplicates-occurrence-preserves-saturated-occurrence.cases.js';
import { registerRetainsLiveQuotaBackoffAcross } from './triggers-part-2/retains-live-quota-backoff-across.cases.js';
import { registerRecordsSkipSupersedesPublicationOperates } from './triggers-part-2/records-skip-supersedes-publication-operates.cases.js';
import { registerRecordsDurableSecurityFactReconciliation } from './triggers-part-2/records-durable-security-fact-reconciliation.cases.js';
beforeAll(beforeAllFixture1, 60_000);
afterAll(schedule.close);
describe('schedule trigger PostgreSQL slice', () => {
  registerDeduplicatesOccurrencePreservesSaturatedOccurrence();

  registerRetainsLiveQuotaBackoffAcross();

  registerRecordsSkipSupersedesPublicationOperates();

  registerRecordsDurableSecurityFactReconciliation();
});
