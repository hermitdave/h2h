# Agnes Flash Task Scheduler

Production-grade, in-memory task scheduler for Node.js. TypeScript,
zero runtime dependencies.

Schedules **1M+ tasks** with priorities, execution timestamps,
dependency tracking, dynamic updates, cycle detection, and O(log n)
retrieval of the next executable task.

Design rationale: [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Quick start

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # unit suite (fast, CI-friendly)
npm run test:scale     # opt-in 1M-task scale verification (SCALE_TESTS=1)
npm run build          # tsup → dist/ (ESM + d.ts)
npm run bench [count] [executions]   # standalone benchmark, tsx
```

## Usage

```ts
import { TaskScheduler } from 'agnes-flash-scheduler';

const scheduler = new TaskScheduler({
  runner: async (task) => {
    // Do the actual work for this task.
    // Throw to fail it; resolve to complete it.
    await doWork(task.payload);
  },
  hooks: {
    onTaskCompleted: (task) => persist(task),  // advisory — failures are
    onTaskFailed: (task, reason) => alertOps(task, reason), // recorded, not thrown
  },
  maxTasks: 1_000_000,        // optional capacity bound
  allowForwardRefs: true,      // optional: deps on not-yet-existing tasks
  nowProvider: () => Date.now(), // inject a fake clock in tests
});

// Register
await scheduler.addTask({ id: 'download', priority: 10 });
await scheduler.addTask({ id: 'convert', priority: 5, dependencies: ['download'] });
await scheduler.addTask({ id: 'verify', priority: 8, dependencies: ['convert'] });

// Execute the next eligible task (runner mode: runs + finalizes inline)
const result = await scheduler.executeNextTask();
// { kind: 'executed', task, startedAt, finishedAt, durationMs, error? }
// { kind: 'running' }  — manual mode (no runner): caller finalizes via
//                        completeTask / failTask
// { kind: 'none' }      — nothing executable right now
```

Manual mode (caller-driven execution):

```ts
const result = await scheduler.executeNextTask(); // no runner configured
if (result.kind === 'running') {
  await doWork(result.task.payload);
  await scheduler.completeTask(result.task.id);   // or failTask(id, reason)
}
```

## API

| Method | Sync/Async | Complexity | Behaviour |
|---|---|---|---|
| `addTask(input)` | async | O(log n + d) | Registers a task; validates deps (rejects cycles, self-refs, unknown refs in strict mode); reconciles status; reconciles forward refs. |
| `updateTask(id, updates)` | async | O(log n + d) | Scalar fields and/or full dependency replacement; re-seats the heap; reconciles status. Terminal tasks and RUNNING dep-changes are rejected. |
| `deleteTask(id)` | async | O(d + r) | Propagates failure to reachable dependents, then removes edges/entry. |
| `completeTask(id, now?)` | async | O(deg) | Requires a non-blocked task; commits COMPLETED; unblocks dependents. |
| `failTask(id, reason?)` / `cancelTask(id, reason?)` | async | O(r) | Terminal transition + downstream failure propagation. |
| `resetTask(id)` | async | O(d) | Revives a terminal task (attempts preserved). |
| `executeNextTask(now?)` | async | O(log n) amortized | Pops heap candidates until an executable one; defers future-dated ones; executes via runner (or reserves RUNNING in manual mode). |
| `getExecutableTasks(now?)` | **sync** | O(n·d̄) | Bulk scan — every task executable at `now`. |
| `getTask(id)` | **sync** | O(1) | Lookup. |
| `getMetrics()` | **sync** | **O(1)** | Incremental-counter snapshot. |
| `auditMetrics()` | **sync** | O(n + e) | Counter-vs-live-state drift report. |
| `wouldCreateCycle(taskId, depId)` | **sync** | O(reachable) | Edge validation, used internally on every write. |
| `hasCycle()` | **async** | O(n + e) | Full-graph iterative DFS audit with witness path; serialized so a long scan never blocks the event loop. |
| `clear()` / `dispose()` | async | O(n) | Reset / retire the scheduler. |

Mutating methods are serialized through an internal single-writer queue
(see ARCHITECTURE.md §4): independent submissions run in strict
submission order; submissions made from inside an executing operation
(runner/hook code) run immediately via a reentrancy bypass — queueing
them behind their parent would deadlock.

## Ordering semantics

Heap comparator: **priority desc → executeTime asc → createdAt asc →
id asc**. `executeTime` is the earliest epoch-ms at which a task may
run; `executeNextTask(now)` only executes tasks whose `executeTime <=
now`.

## Deployment notes

- **Single process, single writer.** The scheduler is designed for one
  Node.js process. Scale out by partitioning the task space across
  processes (shard by tenant/queue) — one scheduler instance per shard.
- **No durability.** State lives in RAM. Persist through hooks and
  rebuild on startup (`addTask` replay, or `heapify` from persisted
  data).
- **Hook failures are advisory** — recorded in metrics, never rolled
  back. Keep hooks fast and idempotent.
- Sync reads may observe in-flight intermediate state while a
  mutation's hook is awaiting; await mutation boundaries if you need
  transactional consistency.

## Scale verification

`npm run test:scale` registers 1,000,000 tasks and executes 10,000 of
them, verifying every execution against an independent ground-truth
simulation of the dependency graph (priority ordering, dependency
ordering, heap consistency). Measured on this machine, two
independent runs, zero mismatches:

| Metric | Run 1 | Run 2 |
|---|---|---|
| 1M adds | 6.45 s | 6.40 s |
| µs per add | 6.4 | 6.4 |
| Memory (heapUsed after adds) | 925 MiB | 925 MiB |
| RSS | 1091 MiB | 1086 MiB |
| Dependency edges | 1,142,856 | 1,142,856 |
| 10k executions | 0.61 s | 0.55 s |
| ms per execution | 0.06 | 0.06 |
| READY entries in heap after run | 2483 | 2483 |
| `getMetrics` | 0.008 ms | 0.007 ms |
| `hasCycle` audit (1M nodes) | 795.6 ms | 675.5 ms |
| `wouldCreateCycle` avg / probe | 0.023 ms | 0.025 ms |

## Repository layout

```
src/          types.ts, errors.ts, binary-heap.ts, scheduler.ts, index.ts
tests/        scheduler.spec.ts (unit), scale.spec.ts (opt-in), helpers/
examples/     benchmark.ts
dist/         build output (tsup)
```
