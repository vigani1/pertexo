import { defineConfig } from 'vitest/config';

import { parallelIntegrationSuite } from '../../infrastructure/testing/worker-databases.mjs';

export default defineConfig({ test: { ...parallelIntegrationSuite } });
