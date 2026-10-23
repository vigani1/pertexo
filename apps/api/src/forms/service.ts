import {
  formSchemaResponseSchema,
  formAccessSchema,
  coordinatedEventHistorySchema,
  formSubmissionResponseSchema,
  publicFormSubmissionResponseSchema,
} from '@pertexo/contracts';
import type { FormStore, PublicFormGrant } from '@pertexo/database/triggers';
import { formOperation } from '../problems/workspace/forms.js';
export class FormService {
  constructor(private readonly store: FormStore) {}
  discover(input: Parameters<FormStore['discover']>[0]) {
    return formOperation(() => this.store.discover(input));
  }
  read(input: Parameters<FormStore['read']>[0], grant?: PublicFormGrant) {
    return formOperation(async () =>
      formSchemaResponseSchema.parse(await this.store.read(input, grant)),
    );
  }
  submit(input: Parameters<FormStore['submit']>[0], grant?: PublicFormGrant) {
    return formOperation(async () =>
      (grant === undefined
        ? formSubmissionResponseSchema
        : publicFormSubmissionResponseSchema
      ).parse(await this.store.submit(input, grant)),
    );
  }
  history(input: Parameters<FormStore['history']>[0]) {
    return formOperation(async () =>
      coordinatedEventHistorySchema.parse(await this.store.history(input)),
    );
  }
  access(input: Parameters<FormStore['access']>[0]) {
    return formOperation(async () =>
      formAccessSchema.parse(await this.store.access(input)),
    );
  }
  setAccess(input: Parameters<FormStore['setAccess']>[0]) {
    return formOperation(async () =>
      formAccessSchema.parse(await this.store.setAccess(input)),
    );
  }
}
