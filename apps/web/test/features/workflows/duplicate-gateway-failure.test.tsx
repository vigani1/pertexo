import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { gatewayFailures } from '../../support/fixtures/gateway-failures';
import { captureCopies, created, open } from './duplicate-recovery/fixture';
import { versionId } from './list/fixtures';

describe('Duplicate workflow after a gateway failure', () => {
  it.each(gatewayFailures)(
    'makes one copy when the person retries after a %s',
    async (_status, gatewayFailure) => {
      const { event, onCreated } = open();
      const sent = captureCopies((count) =>
        count === 1 ? gatewayFailure() : created(),
      );
      await screen.findByText(/last saved, revision 1/u);
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await screen.findByText(/couldn’t confirm whether the copy was made/u);
      expect(onCreated).not.toHaveBeenCalled();

      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );

      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      // One key means the server replays its receipt instead of copying again.
      expect(sent).toHaveLength(2);
      expect(sent[0]?.key).toBeTruthy();
      expect(sent[1]).toEqual(sent[0]);
    },
  );
});
