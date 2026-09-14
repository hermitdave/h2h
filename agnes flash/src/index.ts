/**
 * Agnes Flash task scheduler — public entry point.
 *
 * Re-exports the scheduler, the indexed binary heap, the full type
 * surface, and the error hierarchy. Consumers import everything from
 * this single module.
 */
export { BinaryHeap } from './binary-heap';
export { TaskScheduler } from './scheduler';
export * from './types';
export * from './errors';
