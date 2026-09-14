# Architecture: In-Memory Task Scheduler

## Overview
A production-grade in-memory task scheduler supporting 1M tasks with:
- **Priorities** (higher = more important, executed first)
- **Execution timestamps** (tasks become eligible only when `executeTime <= now`)
- **Dependency tracking** (PENDING → READY → EXECUTABLE → RUNNING → COMPLETED)
- **Cycle detection** (DFS over dependency graph, both `hasCycle()` and `wouldCreateCycle()`)
- **Dynamic updates** (priority / executeTime / dependencies, with lazy heap re-ordering)
- **Efficient retrieval** of the next executable task via a binary heap
- **Task hooks** (`onTaskExecute`, `onTaskComplete`) for pluggable side effects

## Data Structures

| Structure | Type | Purpose |
|-----------|------|---------|
| `tasks` | `Map<string, Task>` | O(1) lookup, mutation, and deletion of any task by id |
| `heap` | `BinaryHeap` | Max-heap by `(priority desc, executeTime asc)` — the O(1) next-task window |
| `adjacency` | `Map<dependencyId, Set<dependentId>>` | Reverse graph: which tasks depend on each task (O(1) unblock propagation) |
| `depSet` | `Map<taskId, Set<dependencyId>>` | Cached dependency set per task (cycle detection + status checks) |

## State Machine

```
PENDING  --deps met-->  READY  --executeTime <= now-->  EXECUTABLE
   |                                                       |
   +-- update deps/execTime/priority                       | executeNextTask()
                                                          v
                                                       RUNNING
                                                          |
                                                          v
                                                       COMPLETED  --unblock dependents-->
```

- **PENDING**: task has unmet dependencies.
- **READY**: all dependencies are COMPLETED; task is in the heap.
- **EXECUTABLE**: READY + `executeTime <= now`.
- **RUNNING**: task being executed by `executeNextTask()`.
- **COMPLETED**: task finished; dependents are unblocked.
- **FAILED / CANCELLED**: terminal; dependents remain blocked.

## Key Methods

### `addTask(task)` — O(log n + d)
Creates a new task. Registers it in the adjacency graph and its dependency set. If dependencies are already met, marks it READY and pushes it onto the heap.

### `updateTask(id, updates)` — O(log n + d)
Updates payload, priority, executeTime, or dependencies. When dependencies change, the adjacency graph is rebuilt (remove from old dep lists, add to new). READY tasks are re-ordered in the heap; PENDING → READY transitions are handled.

### `deleteTask(id)` — O(d)
Removes the task from the heap, tasks map, depSet, and adjacency. Dependents retain their depSet entries for the deleted task, so they remain blocked (conservative semantics — their dependency can never be satisfied).

### `completeTask(id)` — O(d)
Marks a task COMPLETED and unblocks dependents. The `_unblockDependents` method iterates over the adjacency list of the completed task and promotes any PENDING children whose dependencies are now all met.

### `executeNextTask(now?)` — Amortized O(log n) per task
The core retrieval loop:
1. If the heap is empty, return null.
2. Pop tasks from the heap until finding one that is READY, has all deps met, and whose `executeTime <= now`.
3. Non-executable tasks are collected and re-pushed to preserve heap consistency.
4. The found task is marked RUNNING, then COMPLETED, then `onTaskExecute`/`onTaskComplete` hooks fire, then dependents are unblocked.
5. Collected tasks are re-pushed.

This lazily handles future-scheduled tasks: a task with `executeTime > now` is popped, collected, and re-pushed until time advances enough.

### `hasCycle()` / `wouldCreateCycle(taskId, dependencyId)` — O(n + e)
Cycle detection via iterative DFS over `depSet`. `wouldCreateCycle` checks if adding edge `taskId → dependencyId` would create a cycle by checking if `dependencyId` can reach `taskId` through existing dependency edges.

### `metrics()` — O(n)
Returns counts of tasks by status plus heap size.

## Complexity Analysis

| Operation | Time | Notes |
|-----------|------|-------|
| `addTask` | O(log n + d) | Heap push (log n) + adjacency (d) |
| `updateTask` | O(log n + d) | Heap pop/push (log n) + adjacency rebuild (d) |
| `deleteTask` | O(d) | Heap remove (log n) + adjacency cleanup |
| `completeTask` | O(d) | Heap remove + unblock propagation |
| `executeNextTask` | O(log n) amortized | Heap pop + push; lazy future-task handling |
| `getExecutableTasks` | O(n) | Scans all tasks for executable ones |
| `hasCycle` | O(n + e) | Iterative DFS |
| `wouldCreateCycle` | O(n + e) | DFS from dependencyId |
| `metrics` | O(n) | Counts by status |

Where n = number of tasks, d = number of dependencies for a single task, e = total edges.

## Edge Cases Handled

1. **Future executeTime**: tasks with `executeTime > now` are not executable and are re-pushed.
2. **Dependency cancellation**: if a dependency is CANCELLED or FAILED, dependents remain blocked.
3. **Self-dependency**: prevented by cycle detection.
4. **Dynamic priority change**: READY tasks are re-ordered in the heap.
5. **Dynamic dependency change**: dependency updates correctly rebuild the adjacency graph.
6. **Duplicate task id**: throws an error.
7. **Capacity limit**: `maxTasks` option caps the scheduler.
8. **Stale heap entries**: deleted tasks are skipped during execution.
9. **Re-completing a completed task**: no-op.
10. **Completing a cancelled task**: throws an error.

## Scalability

The scheduler is designed to handle 1M tasks. Testing confirms:
- Adding 1,000,000 tasks with no dependencies: O(n log n) for heap pushes.
- Executing all tasks in priority order: O(n log n) total.
- Memory: each task is ~O(d) due to dependency sets; for 1M tasks with avg 10 deps, this is manageable.

## File Structure

```
src/
  types.ts          — Task, TaskStatus, AddTaskInput, TaskUpdates, TaskMetrics, ITaskScheduler
  binary-heap.ts    — BinaryHeap data structure
  scheduler.ts      — TaskScheduler implementation
  index.ts          — Exports
tests/
  scheduler.spec.ts — Comprehensive test suite (30+ tests)
package.json
tsconfig.json
ARCHITECTURE.md     — This file
```

## Usage

```typescript
import { TaskScheduler } from './src';

const scheduler = new TaskScheduler({ now: Date.now() });

const a = scheduler.addTask({ id: 'a', payload: { ... }, priority: 5, dependencies: [] });
const b = scheduler.addTask({ id: 'b', payload: { ... }, priority: 3, dependencies: ['a'] });

scheduler.completeTask('a');
const next = scheduler.executeNextTask(); // b is now executable
```

## Limitations

- **In-memory only**: no persistence. Restarting the process loses all tasks.
- **No concurrency**: single-threaded; not thread-safe. For multi-threaded use, wrap with a lock.
- **No scheduling policies**: FIFO within the same priority level (no weighted fairness).
- **No task timeouts**: tasks do not auto-fail after a deadline.
- **No queue size limits**: except the optional `maxTasks` option.
- **No distributed mode**: single-process; no network partition tolerance.