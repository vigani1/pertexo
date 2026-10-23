import 'reflect-metadata';
import { describe } from 'vitest';

import { registerSerializesDatesValidatorsPaginatesMetadataScopes } from './use-case/serializes-dates-validators-paginates-metadata-scopes.cases.js';
import { registerDeniesRebindingOversizedJSONWrongCase } from './use-case/denies-rebinding-oversized-jsonwrong-case.cases.js';
import { registerEnforcesExactStrongIfMatchGrammar } from './use-case/enforces-exact-strong-if-match-grammar.cases.js';
describe('workflow input case application interface', () => {
  registerSerializesDatesValidatorsPaginatesMetadataScopes();

  registerDeniesRebindingOversizedJSONWrongCase();
});
describe('workflow input case HTTP interface', () => {
  registerEnforcesExactStrongIfMatchGrammar();
});
