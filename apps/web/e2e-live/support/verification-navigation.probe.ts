import { test } from './browser-fixture';
import { openVerificationLink } from './verification-navigation';

// Deliberately failing isolated reporter probe; never part of live acceptance.
test('verification navigation failure omits sensitive details', async ({
  page,
}) => {
  const target = process.env.PERTEXO_VERIFICATION_REDACTION_TARGET;
  if (target === undefined)
    throw new Error('Explicit reporter probe target is required');
  await openVerificationLink(page, target);
});
