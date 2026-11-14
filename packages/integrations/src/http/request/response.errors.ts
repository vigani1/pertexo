/** Fixed explanations shared by executor persistence and the person's run view. */
export const HTTP_RESPONSE_FAILURES = Object.freeze({
  'http.response_too_large': {
    sentence:
      'The service’s response exceeded the response size limit; it was not kept.',
    advice:
      'Check whether the service already performed the action before replaying. Ask for a smaller response or use response files.',
  },
  'http.response_encoding': {
    sentence:
      'The service’s response used an unsupported or invalid text encoding; it was not kept.',
    advice:
      'Check whether the service already performed the action before replaying. Correct the service’s response encoding or choose another endpoint.',
  },
  'http.response_redaction_limit': {
    sentence:
      'The service’s response exceeded the credential masking work limit; it was not kept.',
    advice:
      'Check whether the service already performed the action before replaying. Ask the service for a smaller or less heavily escaped response.',
  },
} as const);
