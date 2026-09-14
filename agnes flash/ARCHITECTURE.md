# Architecture — Agnes Flash Task Scheduler

A production-grade, in-memory task scheduler for a single Node.js process.
It schedules **one million tasks** with priorities, execution timestamps,
dependency tracking, dynamic updates, cycle detection, and O(log n)
retrieval of the next executable task.

---

## 1. Component map

```
src/
├── types.ts        Public type surface: Task, AddTaskInput, TaskUpdates,
│                   NextTaskResult, SchedulerHooks, TaskMetrics,
│                   CycleReport, ITaskScheduler, SchedulerOptions.
├── errors.ts       Error hierarchy with stable machine-readable codes
│                   (UNKNOWN_TASK, DUPLICATE_TASK, INVALID_TASK,
│                    INVALID_DEPENDENCY, CYCLE_DETECTED,
│                    CAPACITY_EXCEEDED, TERMINAL_TASK, INVALID_STATUS,
│                    DISPOSED_SCHEDULER).
├── binary-heap.ts  Generic indexed binary max-heap.
└── scheduler.ts    TaskScheduler — the whole engine.
```

## 2. Core data structures

| Structure | Type | Role |
|---|---|---|
| `tasks` | `Map<id, Task>` | O(1) lookup / mutation / deletion by id. Single source of truth for forward dependency edges (they live on `task.dependencies`). |
| `heap` | `BinaryHeap<string>` | Max-heap of **READY** task ids. The only structure that answers "what runs next". Contract: every entry is a READY task; executability is gated on `executeTime <= now`. |
| `dependents` | `Map<depId, Set<id>>` | Reverse edges. O(1) lookup of "who is waiting on this task" — the mechanism behind unblocking and failure propagation. Kept in sync with forward edges by `_addDependent`/`_removeDependent` (every edge has exactly one owner per side). |
| `counters` | incremental | Metrics maintained in O(1) on every transition — `getMetrics()` never scans the graph. `auditMetrics()` reconciles counters against live state (drift detection). |

### BinaryHeap

Entries are unique keys; an internal index map (`Map<T, number>`)
gives O(1) location of any entry's position, enabling:

- `remove(key)` — O(1) lookup + O(log n) re-sift
- in-place `push(key)` of an already-present key — re-sift without
  remove/re-insert round-trip

Sift operations return the entry's **final** index, so chained
up-then-down sifts operate on the entry's true position (a plain
double-sift from the original index would silently operate on a
different entry after the first swap). `heapify` builds in O(n)
(Floyd's algorithm).

Comparator contract: `compare(a, b) < 0` ⇒ `a` sorts closer to the
root. The scheduler's comparator: **priority desc → executeTime asc →
createdAt asc → id asc**.

## 3. State machine

```
PENDING ──deps met──────────────► READY ──executeTime≤now──► RUNNING
   │                                 │
   └── dep FAILED/CANCELLED ────────┤                          │
        (propagation)               │                    ┌────┴────┐
                                    ▼                    ▼         ▼
                                  (heap)            COMPLETED   FAILED
                                                        │
                                     unblock dependents │ propagate failure
```

- **PENDING** — at least one dependency unmet (not yet COMPLETED).
  Never enters the heap.
- **READY** — all dependencies COMPLETED. Eligible for the heap.
- **RUNNING** — reserved by `executeNextTask`; attempt counter
  increments on every reservation.
- **COMPLETED / FAILED / CANCELLED** — terminal. Only `resetTask`
  revives them.

Semantics that matter in production:

1. **Completion requires satisfied dependencies.** Completing a PENDING
   task is refused (`InvalidStatusError`) — the scheduler does not lie
   about state.
2. **Failure is contagious.** When a task fails or is cancelled, every
   non-terminal task *reachable through the reverse graph* is marked
   `FAILED` with the originating reason, iteratively (BFS, explicit
   queue — safe at any graph size). Traversal **expands through**
   already-FAILED/CANCELLED nodes (their dependents are also victims)
   but **never through COMPLETED ones**: a completed upstream
   *satisfies* its dependents — including the retry-after-reset case,
   where a task completed successfully on attempt 1 and its upstream
   failed on attempt 2.
3. **Deletion is terminal failure.** `deleteTask` propagates
   `upstream_deleted:<id>` to all reachable dependents *before*
   removing the task's edges, then cleans up. Dependents keep dangling
   references in their dependency sets — harmless, because propagation
   already moved them to a terminal status.
4. **Forward references** (`allowForwardRefs: true`) register
   dependencies on not-yet-existing tasks. They stay PENDING blockers
   (a missing dep is *not* counted as "failed" — it is an expectation
   that can still be satisfied) and are unblocked automatically when
   the referenced task completes.

## 4. Single-writer serialization (concurrency model)

JavaScript is single-threaded, but an async scheduler still has a
classic concurrency hazard: **awaited hooks and runners yield to the
event loop**, so another caller's mutation can land *mid-operation*.

Every mutating public method runs through `_serialized`, a single-writer
queue with a **reentrancy bypass**:

- **Independent submissions** chain strictly in submission order
  (FIFO pending queue, settled entries dequeued on completion — retained
  memory tracks the in-flight backlog, not the scheduler's entire
  history).
- **Nested submissions** — recognized because they carry the writer
  token of the currently-executing operation, propagated across async
  boundaries by `AsyncLocalStorage` — run *immediately* instead of
  queueing behind the operation that awaits them. Queueing a nested call
  behind its parent would be a **circular wait** (deadlock): the parent
  waits for the child, the child waits for the parent.
- Both branches run the op under `storage.run(token, …)` with
  `_current` set for the duration, so reentrancy is recognized at any
  nesting depth.

Consequence: concurrent callers never observe interleaved state, and
runner/hook code that calls scheduler methods mid-flight composes
correctly instead of deadlocking. Read-only methods (`getTask`,
`getMetrics`, `getExecutableTasks`, `wouldCreateCycle`,
`auditMetrics`) are synchronous — they mutate nothing. Caveat (documented
in the README): a synchronous read issued while a mutation's hook is
awaiting may observe in-flight intermediate state.

`hasCycle` is the one read that is *serialized* (async): a full-graph
audit over 1M nodes takes seconds, and a synchronous audit would block
the event loop for that whole duration.

## 5. Complexity analysis

| Operation | Complexity | Notes |
|---|---|---|
| `addTask` | O(log n + d) | d = dependency degree. Validation O(d·(v+e_reachable)); heap insert O(log n) when READY. |
| `updateTask` | O(log n + d_old + d_new) | Edge bookkeeping O(d_old + d_new); heap re-seat O(log n) when a comparator-relevant field changed. |
| `deleteTask` | O(d + r) | r = size of the reachable dependent subgraph (iterative BFS). |
| `completeTask` | O(deg) | Unblock scan over direct dependents. |
| `failTask` / `cancelTask` | O(r) | BFS propagation over the reachable subgraph. |
| `resetTask` | O(d) | Dependency re-evaluation. |
| `executeNextTask` | **O(log n) amortized** | Heap pop O(log n) per candidate. Worst case: O(k·log n) where k = future-dated READY entries that must be popped and re-pushed each call. |
| `getExecutableTasks` | O(n·d̄) | Full scan; deliberately not routed through the heap (avoids recursive refresh). |
| `getMetrics` | **O(1)** | Incremental counters. |
| `auditMetrics` | O(n + e) | Full reconciliation scan. |
| `wouldCreateCycle` | O(v + e_reachable) | Bounded BFS with early exit — cheap in the hot path (edge validation on every add/update). |
| `hasCycle` | O(n + e), early exit | Iterative 3-color DFS, explicit stack (recursive DFS would overflow the JS stack at 1M nodes). Parent-pointer chain extracts the witness cycle. |

Memory: **O(n + e)** — one Task object per node (~a few hundred bytes),
one reverse-edge set entry per edge, one heap index entry per READY
task. Measured values in §7.

### Why the pop-and-re-push loop is the right next-task design

The heap orders by **priority first, time second**. The root of the heap
is the highest-priority READY task — which may be *future-dated*. A
lower-priority task with `executeTime <= now` can therefore be
executable while sitting below a deferred root. Time-gating must happen
*inside* the pop loop: pop candidates until one passes
`status === READY && depsMet && executeTime <= now`; future-dated
candidates are collected and re-pushed; stale (non-READY) candidates
are discarded and will re-enter the heap when unblock events promote
them. The alternative — a secondary time-ordered index — costs
O(m·log n) per query and still needs priority selection among the
time-qualified set; it is strictly more machinery for no asymptotic
gain.

### Why cycles are prevented at write-time — and why `hasCycle` still matters

`_validateDeps` rejects any edge whose addition would close a loop
(BFS from the dependency id, stopping at the target). Because
validation runs against the *live* graph and the scheduler serializes
all mutations, **no sequence of validated writes can plant a cycle** —
each update sees all previous updates' edges. `hasCycle` remains the
defense-in-depth audit for corruption that bypasses the API
(direct object mutation, bugs, future API holes) and returns the
witness cycle path.

## 6. State-transition hooks & metrics

- Hooks (`onTaskAdded/Updated/Deleted/Started/Completed/Failed/
  Cancelled/Unblocked/Reset`) are **advisory**: state transitions
  commit *before* hooks fire, so hooks observe final graph state;
  hook failures are recorded in metrics (`lastError`, `hookErrors`)
  and never roll back committed state.
- Metrics are O(1) snapshots of incremental counters, safe to poll on
  every operation. `auditMetrics()` exposes drift between counters and
  live state — the self-check that keeps the incremental bookkeeping
  honest.

## 7. Measured performance (1M scale run — real measurements)

Measured on this machine (Apple Silicon) across two independent runs;
values below are the observed pair (run 1 / run 2). The scale test
verifies, at every step, that the scheduler's choice equals an
independent ground-truth simulation of the dependency graph — both
runs passed all 10,000 execution steps with zero mismatches.

| Metric | Value |
|---|---|
| 1M adds, wall time | 6.45 s / 6.40 s (≈ 6.4 µs per add, serialized) |
| Memory after adds | heapUsed 925 MiB (delta ≈ 386 MiB); RSS ≈ 1088 MiB |
| Amortized per-task footprint | ≈ 0.39 KB/task (386 MiB ÷ 1M) — task object + edge/heap/index bookkeeping |
| 10k executions, wall time | 0.61 s / 0.55 s (≈ 0.06 ms per call) |
| Heap consistency | heap size == ground-truth candidate count (2483) after the run |
| `getMetrics` | 0.008 ms (O(1) confirmed) |
| `hasCycle` audit over 1M nodes / 1.14M edges | 0.80 s / 0.68 s (full iterative DFS; acyclic graph ⇒ no early exit) |
| `wouldCreateCycle` probe | 0.023 / 0.025 ms average over 100 probes |

## 8. Known limits & deployment guidance

- **In-memory only.** No persistence — a process restart loses all
  state. Production deployments persist through hooks
  (`onTaskCompleted` → database write) and rebuild on startup
  (`addTask` replay or `heapify` of the persisted graph).
- **Single process.** The scheduler is single-writer by design; scale
  horizontally by partitioning the task space across processes
  (shard by tenant/queue), one scheduler instance each.
- **GC pressure at 1M.** V8 per-object overhead dominates memory; the
  measured footprint (§7) is the honest number. Budget for it.
- **Comparator cost.** `compareIds` performs up to 4 field reads per
  comparison; heap operations at 1M entries do ~log₂(10⁶) ≈ 20
  comparisons each.
- **Future-dated churn.** Aggressive polling of a heap dominated by
  future-scheduled tasks multiplies pop/re-push work; gate caller
  polling on `peek()`-style checks or bound poll frequency.
