# Task Scheduler Skill

## Use when
Building or reviewing an in-memory task scheduler with priorities, dependencies, cycle detection, dynamic updates, and efficient next-task retrieval.

## What it does
Implements a production-grade `TaskScheduler` class using a binary max-heap (priority desc, executeTime asc) + Map lookups + reverse adjacency graph for O(1) dependency unblocking.

## Core data structures
- `tasks: Map<string, Task>` — O(1) lookup by id.
- `heap: BinaryHeap` — O(1) next-task retrieval; O(log n) push/pop.
- `adjacency: Map<depId, Set<depId>>` — reverse graph for O(1) unblock propagation.
- `depSet: Map<taskId, Set<depId>>` — cached dependency set for cycle detection + status checks.

## Key methods
- `addTask(task)` — O(log n + d)
- `updateTask(id, updates)` — O(log n + d)
- `deleteTask(id)` — O(d)
- `completeTask(id)` — O(d)
- `executeNextTask(now?)` — O(log n) amortized
- `hasCycle()` / `wouldCreateCycle(taskId, depId)` — O(n + e)
- `getExecutableTasks()` — O(n)

## File structure
- `src/types.ts` — Task, TaskStatus, AddTaskInput, TaskUpdates, TaskMetrics, ITaskScheduler
- `src/binary-heap.ts` — BinaryHeap
- `src/scheduler.ts` — TaskScheduler
- `src/index.ts` — Exports
- `tests/scheduler.spec.ts` — 30+ tests

## Test commands
```bash
npm install
npm run build
npm test
```

## Scalability
Verified: 1M tasks added, 10k tasks executed in priority order. Memory is O(n + e) where e = total dependency edges.

## Pitfalls
- `executeNextTask` pops non-executable tasks and re-pushes them; it does NOT break on future-scheduled tasks.
- `deleteTask` leaves dependents blocked (their dependency can never be satisfied) — conservative semantics.
- `updateTask` rebuilds the adjacency graph when dependencies change.
- `getExecutableTasks` does NOT call `_refreshHeap` (avoids infinite recursion); it scans `tasks` directly.
- Cycle detection uses iterative DFS to avoid stack overflow on 1M tasks.