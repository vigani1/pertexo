import { createContext } from 'react';

const NONE: ReadonlyMap<string, number> = new Map();

/**
 * Open discussions about each step, by step ID. The route supplies them, so
 * the editor shows where people are talking without owning comments.
 */
export const StepDiscussionsContext = createContext(NONE);
