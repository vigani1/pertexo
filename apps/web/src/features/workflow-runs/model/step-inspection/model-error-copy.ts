export const MODEL_STEP_ERRORS: Readonly<
  Record<string, { sentence: string; advice: string }>
> = {
  'model.address_denied': {
    sentence: 'Pertexo blocked the model endpoint address.',
    advice:
      'Check the connection’s API base URL and your instance’s network policy.',
  },
  'model.credential_rejected': {
    sentence: 'The provider rejected the API key.',
    advice: 'Check the API key in the connection.',
  },
  'model.model_unavailable': {
    sentence: 'The provider could not use this model.',
    advice:
      'Check the model identifier and whether your API key can access it.',
  },
  'model.output_truncated': {
    sentence: 'The model stopped at its output limit.',
    advice: 'Increase the maximum output tokens or ask for a shorter answer.',
  },
  'model.output_refused': {
    sentence: 'The model refused to answer the prompt.',
    advice: 'Review the prompt and the provider’s usage rules.',
  },
  'model.provider_timeout': {
    sentence: 'The provider did not answer before the timeout.',
    advice: 'Increase the step timeout or try again later.',
  },
  'model.rate_limited': {
    sentence: 'The provider is receiving too many requests.',
    advice: 'Wait before running again or check the provider’s limits.',
  },
  'model.output_schema_invalid': {
    sentence:
      'The model’s answer still did not match the output schema after repair.',
    advice: 'Review the prompt and output schema, then test the step again.',
  },
  'model.invalid_response': {
    sentence: 'The provider returned a response Pertexo could not read.',
    advice: 'Check that the endpoint supports this model and mode.',
  },
  'model.request_too_large': {
    sentence: 'The model request was too large.',
    advice: 'Shorten the mapped prompt or simplify the output schema.',
  },
  'model.response_too_large': {
    sentence: 'The provider’s response was too large.',
    advice: 'Lower the maximum output tokens or ask for a shorter answer.',
  },
  'model.credential_echoed': {
    sentence: 'Pertexo discarded a model response that contained the API key.',
    advice: 'Check the endpoint and rotate the key before trying again.',
  },
  'model.retry_after_exceeded': {
    sentence: 'The provider asked Pertexo to wait longer than the retry limit.',
    advice: 'Try again after the provider’s rate limit resets.',
  },
};
