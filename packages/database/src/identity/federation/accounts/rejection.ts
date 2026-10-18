/** Rolls back a rejected proof, including any identity or grant tentatively created in its transaction. */
export class SignInProofRejectedError extends Error {
  constructor() {
    super('Sign-in proof is unavailable');
    this.name = 'SignInProofRejectedError';
  }
}
