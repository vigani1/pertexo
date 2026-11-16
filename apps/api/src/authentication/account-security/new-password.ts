import { PASSWORD_LIMITS } from '@pertexo/workflow-model';
import { z } from 'zod';

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_LIMITS.minimumCharacters)
  .max(PASSWORD_LIMITS.maximumCharacters);
