import { describe, expect, it } from 'vitest';

import { FailureNotificationStateError } from '../../src/testing.js';
import {
  accessedSecretVersions,
  appendAddress,
  claimRetry,
  complete,
  emailBinding,
  failedRun,
  fence,
  firstAddress,
  load,
  rotateCredential,
  secondAddress,
  sendThatMayHaveGoneOut,
  storedIntent,
} from './rotation.support.js';

describe('a retry after a send that may have gone out', () => {
  it('does not load a rotated credential, and is recorded as outcome unknown', async () => {
    const alert = await failedRun('email');
    await sendThatMayHaveGoneOut(alert, emailBinding('a'));
    const rotated = await rotateCredential(alert.connectionId);
    const retry = await claimRetry(alert);
    expect(retry).toMatchObject({
      attemptNumber: 2,
      deliveryUnresolved: true,
      deliveryBinding: emailBinding('a'),
    });

    await expect(load(alert, retry.attemptNumber)).rejects.toBeInstanceOf(
      FailureNotificationStateError,
    );
    await expect(
      fence(alert, retry.attemptNumber, emailBinding('a')),
    ).rejects.toBeInstanceOf(FailureNotificationStateError);
    expect(await accessedSecretVersions(alert.connectionId)).not.toContain(
      rotated,
    );

    // What the worker answers when the load is refused on an unresolved send.
    await expect(
      complete(alert, retry.attemptNumber, {
        kind: 'outcome_unknown',
        safeErrorCode: 'delivery.identity_changed',
        possiblyDispatched: true,
      }),
    ).resolves.toBe('completed');
    expect(await storedIntent(alert.intentId)).toMatchObject({
      status: 'outcome_unknown',
      safe_error_code: 'delivery.identity_changed',
      possibly_dispatched: true,
      delivery_binding: emailBinding('a'),
    });
  });

  it('is refused at the fence when the credential rotates after it loaded', async () => {
    const alert = await failedRun('email');
    await sendThatMayHaveGoneOut(alert, emailBinding('a'));
    const retry = await claimRetry(alert);
    await expect(load(alert, retry.attemptNumber)).resolves.toMatchObject({
      secretVersionId: alert.pinnedSecretVersionId,
    });

    await rotateCredential(alert.connectionId);

    await expect(
      fence(alert, retry.attemptNumber, emailBinding('a')),
    ).rejects.toBeInstanceOf(FailureNotificationStateError);
    expect((await storedIntent(alert.intentId)).status).toBe('claimed');
  });

  it('with nothing changed goes out again only under the same identity', async () => {
    const alert = await failedRun('email');
    await sendThatMayHaveGoneOut(alert, emailBinding('a'));
    const retry = await claimRetry(alert);

    await expect(load(alert, retry.attemptNumber)).resolves.toMatchObject({
      secretVersionId: alert.pinnedSecretVersionId,
      toEmail: firstAddress('email'),
    });
    await expect(
      fence(alert, retry.attemptNumber, emailBinding('b')),
    ).rejects.toBeInstanceOf(FailureNotificationStateError);
    await fence(alert, retry.attemptNumber, emailBinding('a'));
    expect(await storedIntent(alert.intentId)).toMatchObject({
      status: 'dispatching',
      delivery_binding: emailBinding('a'),
    });
  });

  it('stays on the address that send used when a version is appended afterwards', async () => {
    const alert = await failedRun('email');
    await sendThatMayHaveGoneOut(alert, emailBinding('a'));
    await appendAddress(alert);
    const retry = await claimRetry(alert);

    await expect(load(alert, retry.attemptNumber)).resolves.toMatchObject({
      toEmail: firstAddress('email'),
    });
  });

  // The rule is "what that send used", which isn't the same as what the run
  // pinned once a first send goes through a credential rotated during the run.
  it('stays on the credential that send used when it rotated before the send', async () => {
    let rotated = '';
    const alert = await failedRun('email', async ({ connectionId }) => {
      rotated = await rotateCredential(connectionId);
    });
    const used = await sendThatMayHaveGoneOut(alert, emailBinding('a'));
    expect(used.secretVersionId).toBe(rotated);
    const retry = await claimRetry(alert);

    await expect(load(alert, retry.attemptNumber)).resolves.toMatchObject({
      secretVersionId: rotated,
    });
  });

  it('stays on the address that send used when it changed before the send', async () => {
    const alert = await failedRun('email', (target) => appendAddress(target));
    const used = await sendThatMayHaveGoneOut(alert, emailBinding('a'));
    expect(used).toMatchObject({ toEmail: secondAddress('email') });
    const retry = await claimRetry(alert);

    await expect(load(alert, retry.attemptNumber)).resolves.toMatchObject({
      toEmail: secondAddress('email'),
    });
  });
});
