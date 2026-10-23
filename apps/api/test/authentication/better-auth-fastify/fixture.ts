import type { FastifyInstance } from 'fastify';

export const allowingRateLimit = {
  consume: () => Promise.resolve({ allowed: true as const }),
};

export const applications: FastifyInstance[] = [];

export async function cleanBetterAuthFastifyBridgeFixture() {
  await Promise.all(
    applications.splice(0).map((application) => application.close()),
  );
}
