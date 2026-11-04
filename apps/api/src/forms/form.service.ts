import type { FormStore, PublicFormGrant } from '@pertexo/core/triggers';

export class FormService {
  constructor(private readonly store: FormStore) {}
  discover(input: Parameters<FormStore['discover']>[0]) {
    return this.store.discover(input);
  }
  read(input: Parameters<FormStore['read']>[0], grant?: PublicFormGrant) {
    return this.store.read(input, grant);
  }
  submit(input: Parameters<FormStore['submit']>[0], grant?: PublicFormGrant) {
    return this.store.submit(input, grant);
  }
  history(input: Parameters<FormStore['history']>[0]) {
    return this.store.history(input);
  }
  access(input: Parameters<FormStore['access']>[0]) {
    return this.store.access(input);
  }
  setAccess(input: Parameters<FormStore['setAccess']>[0]) {
    return this.store.setAccess(input);
  }
}
