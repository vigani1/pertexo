import type { ErrorWorkflowDeliveryInput as DeliveryInput } from './input.js';

export type ErrorWorkflowDeliveryInput = DeliveryInput;
export interface ErrorWorkflowStore {
  dispatch(input: ErrorWorkflowDeliveryInput): Promise<void>;
  close(): Promise<void>;
}
