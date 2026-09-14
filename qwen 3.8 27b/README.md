# In-Memory Task Scheduler

Production-ready in-memory task scheduler for **1,000,000+ tasks** — priorities,
execution timestamps, dependency tracking, dynamic updates, cycle detection, and
O(log n) next-executable retrieval. TypeScript, zero runtime dependencies.

Full design rationale, data structures, complexity analysis, and scalability
discussion: **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Quick start

```bash
npm install
npm run typecheck   # strict tsc, no emit
npm test            # 88 unit/edge-case tests
npm run test:perf   # 1M-task performance suite (SKIP_PERF=1 to skip)
npm run demo        # end-to-end release-pipeline demo
```

## API (30-second tour)

```ts
import { TaskScheduler } from './dist/src';

const s = new TaskScheduler({ now: Date.now(), maxTasks: 1_000_000 });

s.addTask({ id: 'build', priority: 10, executeTime: 1_700_000_000, dependencies: ['lint'] });

// Claim the next executable task (highest priority among due ∧ deps met)
const t = s.claimNextExecutable();          // → Task | null, marks RUNNING
s.completeTask(t.id);                        // unblocks dependents

// Or run it through an executor (sync or async):
await s.executeNextTask(async (task) => runJob(task.payload));

s.updateTask('build', { priority: 99, dependencies: ['lint', 'assets'] }); // cycle-checked, versioned
s.deleteTask('build');                      // fail-safe: dependents re-block, surfaced by getBlockedTasks()
s.findCycle();                              // → ['a','b','a'] | null — iterative, 1M-node safe
s.nextWakeTime();                           // O(1) — sleep the event loop until then
```

## Commands

| Command | What |
|---------|------|
| `npm run typecheck` | strict `tsc --noEmit` (incl. `noUncheckedIndexedAccess`) |
| `npm test` | 3 suites, 88 tests: heap, core behavior, edge cases |
| `npm run test:perf` | 1M adds, 1M full drain, adversarial claim, 1M-cycle check, memory |
| `npm run demo` | compiled end-to-end demo with output |

## Layout

```
src/
  types.ts          Task, inputs, options, metrics types
  errors.ts         typed error hierarchy (CycleError, StaleVersionError, ...)
  BinaryHeap.ts     comparator-driven min-heap + position map (O(log n) remove)
  TaskScheduler.ts  the engine: two-heap time/priority split, unblock, cycle DFS
  index.ts          public exports
tests/
  BinaryHeap.spec.ts     10 tests
  TaskScheduler.spec.ts  54 tests (lifecycle, ordering, updates, transitions)
  EdgeCases.spec.ts      24 tests (cycles, dangling deps, batches, 10k DAG drain)
  Performance.spec.ts    6 tests (1M scale proof, memory)
examples/demo.ts          runnable release-pipeline demo
```

## Guarantees (see ARCHITECTURE.md for proofs & measurements)

- **Ordering:** priority DESC, then executeTime ASC, then creation sequence — a
  total order, so drains are deterministic.
- **Safety:** cycles impossible via mutation (preventive check, atomic updates);
  bulk-imported cycles can't break the scheduler (members just stay PENDING,
  rest of the graph runs); failed/cancelled deps never auto-unblock dependents.
- **Scale:** 1M adds 2.1s, 1M full drain 5.2s, adversarial claim <1ms,
  ~555 MB resident after GC — measured, not modeled.
