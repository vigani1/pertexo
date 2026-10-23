import { describe } from 'vitest';

import { createIngressFixture } from './ingress/fixture.js';
import {
  createRequestShapeFixture,
  createDeliveryLogFixture,
} from './ingress/examples.js';
import { registerReturnsPlain202SkipVerifiedSDeliveries } from './ingress/authentication/modes.cases.js';
import { registerKeepsPreflightStorageReadRefusesUnknownEndpoints } from './ingress/authentication/origins.cases.js';
import { registerFallsBackAcceptedReceiptOnTimeoutWithout } from './ingress/responses/waiting.cases.js';
import { registerReturnsOneAuthoritativeAcceptanceTracingInvokesCallback } from './ingress/responses/admission.cases.js';
import { registerHandlesNameThroughRawHTTPHeaders } from './ingress/authentication/wire-headers.cases.js';
import { registerAcceptsCaseInsensitiveJSONMediaTypeUTF } from './ingress/authentication/representation.cases.js';
import { registerReturnsOriginalRunReferenceExactCompletedReplay } from './ingress/responses/replay.cases.js';
import { registerReadsFormFieldsPlainTextJsonEmpty } from './ingress/requests/shapes.cases.js';
import { registerRecordsNameMetadataSameResponse } from './ingress/delivery/log.cases.js';
describe('generic webhook ingress', () => {
  const scopeFixture = createIngressFixture();
  const { setup } = scopeFixture;

  registerReturnsPlain202SkipVerifiedSDeliveries(scopeFixture);

  registerKeepsPreflightStorageReadRefusesUnknownEndpoints(scopeFixture);

  registerFallsBackAcceptedReceiptOnTimeoutWithout(scopeFixture);

  registerReturnsOneAuthoritativeAcceptanceTracingInvokesCallback(scopeFixture);

  registerHandlesNameThroughRawHTTPHeaders(scopeFixture);

  describe('request shapes', () => {
    const scopeFixture = createRequestShapeFixture({ setup });

    registerReadsFormFieldsPlainTextJsonEmpty(scopeFixture);
  });
  registerAcceptsCaseInsensitiveJSONMediaTypeUTF(scopeFixture);

  registerReturnsOriginalRunReferenceExactCompletedReplay(scopeFixture);

  describe('delivery log (ADR 045)', () => {
    const scopeFixture = createDeliveryLogFixture({ setup });

    registerRecordsNameMetadataSameResponse(scopeFixture);
  });
});
