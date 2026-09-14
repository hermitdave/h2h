import type { AddTaskInput } from '../../src/types';

export interface GeneratedGraph {
  inputs: AddTaskInput[];
  /** depOf[i]: indices of the tasks that task i depends on. */
  depOf: number[][];
  /** dependentsOf[j]: indices of the tasks that depend on task j. */
  dependentsOf: number[][];
}

/**
 * Deterministic task DAG: task i depends on its "half" ancestor
 * floor(i/2) (binary-tree structure), plus floor(i/3) when i % 7 === 0.
 * Every dependency points to an earlier task, so the graph is acyclic
 * by construction. executeTime is a single fixed value for every task,
 * so the scheduler's executeTime tie-break never discriminates; ordering
 * is determined by priority, then createdAt (which advances one
 * millisecond per registration under the deterministic clock).
 */
export function generateTaskInputs(count: number, now: number): GeneratedGraph {
  const inputs: AddTaskInput[] = [];
  const depOf: number[][] = [];
  const dependentsOf: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < count; i++) {
    const deps: number[] = [];
    if (i > 0) deps.push(Math.floor(i / 2));
    if (i > 1 && i % 7 === 0) deps.push(Math.floor(i / 3));
    depOf.push(deps);
    for (const d of deps) dependentsOf[d]!.push(i);
    inputs.push({
      id: `task-${String(i).padStart(7, '0')}`,
      name: `Task ${i}`,
      priority: (i * 7919) % 101,
      executeTime: now,
      dependencies: deps.map((d) => `task-${String(d).padStart(7, '0')}`),
    });
  }
  return { inputs, depOf, dependentsOf };
}
