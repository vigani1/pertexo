import { problemResponse } from '../routes/openapi-primitives.js';

export const sharedProblemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  Unexpected: problemResponse('Unexpected server error'),
  RateLimited: problemResponse('Rate limited'),
  PreconditionRequired: problemResponse('Precondition required'),
  PayloadTooLarge: problemResponse('Payload too large'),
});
