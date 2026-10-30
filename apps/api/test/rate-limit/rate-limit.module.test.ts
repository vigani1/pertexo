import { describe, expect, it, vi } from 'vitest';

import { CsvExportAdmission } from '../../src/platform/http/csv/admission.js';
import { HttpRateLimitAdmission } from '../../src/platform/rate-limit/admission.js';
import { RateLimitModule } from '../../src/platform/rate-limit/module.js';
import { Test } from '@nestjs/testing';
import { ApiLifecycleModule } from '../../src/platform/health/drain-state.js';

describe('rate-limit module wiring', () => {
  it('admits through the supplied service and closes it on shutdown', async () => {
    const rateLimit = {
      consume: vi.fn().mockResolvedValue({ allowed: true }),
      acquireExclusiveSlot: vi.fn().mockResolvedValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const testing = await Test.createTestingModule({
      imports: [ApiLifecycleModule, RateLimitModule.register(rateLimit)],
    }).compile();

    await testing
      .get(HttpRateLimitAdmission, { strict: false })
      .admit('authenticated_read', { actorId: 'actor', workspaceId: 'w' });
    expect(rateLimit.consume).toHaveBeenCalledOnce();
    expect(testing.get(CsvExportAdmission, { strict: false })).toBeDefined();

    await testing.close();
    expect(rateLimit.close).toHaveBeenCalledOnce();
  });
});
