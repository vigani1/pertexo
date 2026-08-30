import { SetMetadata } from '@nestjs/common';

import type { RateLimitEndpointClass } from '@pertexo/rate-limit';

export const RATE_LIMIT_METADATA = Symbol('RATE_LIMIT_METADATA');
export const RATE_LIMIT_EXEMPT = Symbol('RATE_LIMIT_EXEMPT');

export function RateLimit(
  endpointClass: RateLimitEndpointClass,
): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_METADATA, endpointClass);
}

export function RateLimitExempt(): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_METADATA, RATE_LIMIT_EXEMPT);
}
