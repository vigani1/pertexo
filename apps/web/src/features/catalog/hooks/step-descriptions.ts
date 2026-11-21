import { createContext, useContext } from 'react';
import { describeStep, type DescribeStep } from '../model/steps/presentation';

export const StepDescriptionsContext =
  createContext<DescribeStep>(describeStep);

export function useStepDescriptions(): DescribeStep {
  return useContext(StepDescriptionsContext);
}
