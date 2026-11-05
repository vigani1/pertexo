/** Fixed explanations shared by executor persistence and the person's run view. */
export const HTTP_RESPONSE_FAILURES = Object.freeze({
  'http.response_encoding': {
    sentence:
      'The service’s response used an unsupported or invalid text encoding; it was not kept.',
    advice:
      'Correct the service’s response encoding or choose another endpoint, then replay the run.',
  },
  'http.response_redaction_limit': {
    sentence:
      'The service’s response exceeded the credential masking work limit; it was not kept.',
    advice:
      'Ask the service for a smaller or less heavily escaped response, then replay the run.',
  },
} as const);
