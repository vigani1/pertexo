import { useQueryClient } from '@tanstack/react-query';
import type {
  FormAccess,
  FormAccessRequest,
  FormSubmissionRequest,
} from '@pertexo/contracts';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import {
  sendForm,
  setFormAccess,
  type FormScope,
  type MemberFormScope,
} from './forms.api';
import { formAccessQueryOptions } from './forms.queries';

/** Changes who may answer a form; the access snapshot refetches after `onAccepted`. */
export function useFormAccessCommand(
  scope: MemberFormScope,
  onAccepted: (result: FormAccess) => void,
) {
  const cache = useQueryClient();
  return useRetainedCommand(
    (body: FormAccessRequest, key: string) => setFormAccess(scope, body, key),
    async (result) => {
      onAccepted(result);
      await cache.invalidateQueries({
        queryKey: formAccessQueryOptions(scope).queryKey,
      });
    },
  );
}

/** Sends one response in the page's upload session, so its files go with it. */
export function useFormSubmission(
  scope: FormScope,
  session: string,
  failureMessage: (cause: unknown) => string | undefined,
) {
  return useRetainedCommand(
    (body: FormSubmissionRequest, key: string) =>
      sendForm(scope, body, key, session),
    undefined,
    { failureMessage },
  );
}
