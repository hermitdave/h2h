# In-Memory Task Scheduler — Architecture & Design Document

Production-ready in-memory task scheduler for **1,000,000+ tasks** with priorities,
execution timestamps, dependency tracking, dynamic updates, cycle detection, and
O(log n) next-executable retrieval. TypeScript, zero runtime dependencies.

## 1. Requirements → design decisions

| # | Requirement | Decision | Rationale |
|---|-------------|----------|-----------|
| 1 | 1M tasks | `Map<string, Task>` + two binary heaps | O(1) lookup; heap ops O(log n) ≈ 20 comparisons at 1M. Memory profile in §6. |
| 2 | Priorities | Due-heap key: `(priority DESC, executeTime ASC, sequence ASC)` | Highest priority first; deterministic total order (sequence breaks same-priority/time ties → stable FIFO, no nondeterminism in replay). |
| 3 | Execution timestamps | **Two-heap time/priority split** (below) | A single priority-ordered heap makes a future high-priority task block every lower-priority *due* task, forcing O(n) pop-and-collect per claim. The two-heap design keeps claims O(log n) amortized, including the adversarial case. |
| 4 | Dependency tracking | Forward `depsOf` + reverse `dependents` maps, O(1) `unmetDependencies` counter per task | Unblock on completion is O(degree) not O(degree × fan-in). |
| 5 | Dynamic updates | `updateTask` with remove→mutate→re-insert; cycle check *before* mutation (atomic); optimistic concurrency via `version`/`expectedVersion` | Key fields (priority/executeTime) are heap keys; they must never mutate in place — remove + re-insert preserves the heap invariant. |
| 6 | Cycle detection | **Preventive** (every mutation path) + **detective** (`hasCycle`/`findCycle`, iterative 3-color DFS) | Preventive keeps the live graph acyclic; detective validates bulk-imported state and returns the actual cycle path for diagnostics. |
| 7 | Next executable | `claimNextExecutable`: promote due tasks, walk due-heap top discarding stale entries, claim top | Amortized O((p + s + 1)·log n); p = promotions (monotonic), s = stale discards. Steady state: O(log n). |

## 2. Architecture

```
                ┌──────────────────────────────────────────────────────┐
                │                   TaskScheduler                      │
                │                                                      │
  addTask ─────▶│  tasks: Map<id, Task>          O(1) lookup, 1M slots │
  updateTask ──▶│  depsOf:  Map<id, Set<depId>>  forward edges         │
  deleteTask ──▶│  dependents: Map<depId, Set<id>>  reverse edges      │
                │                                                      │
                │  futureHeap  (min by executeTime) ──promote──▶ dueHeap
                │  tasks not yet due                          (max by priority,
                │       ▲                                      then time, seq)
                │       └──update with future time──┤   claimNextExecutable
                │                                    │   pops due-heap top
                └────────────────────────────────────┴────────────────┘
```

### The core design decision: two heaps, not one

A task is **executable** when `status = READY ∧ executeTime ≤ now ∧ all deps COMPLETED`.

* **Single priority-heap** (naive): key `(priority DESC, time ASC)`. Claim = pop top;
  if top is not due, it must be set aside and the heap walked — a high-priority
  future task at the top hides every due task below it. Worst case O(n·log n) per
  claim under an adversarial workload (99% high-priority-future + 1 due).
* **Two-heap design (adopted)**:
  * `futureHeap` — min-heap on `executeTime`. Its root is `nextWakeTime()`, so the
    host event loop can sleep precisely.
  * `dueHeap` — max-heap on `priority` (then time, then sequence).
  * **Promotion** is the only time→priority gate: when the clock advances, tasks
    with `executeTime ≤ now` move future→due. Promotion is *monotonic* — each task
    promotes at most once per due-window — so it is amortized O(1) per claim and
    the adversarial case degrades to O(1): the due task claims while all 100k
    future tasks sit untouched in `futureHeap` (verified in `Performance.spec.ts`).

### State machine

```
        ┌─────────────────────────────────────────────────────┐
        │                                                     │
  add ─▶ PENDING ──all deps COMPLETED──▶ READY ──claim──▶ RUNNING
        ▲                              │                 │  │
        │                              │ update adds     │  │ executeNextTask
        │                              │ unmet dep       ▼  ▼
        └──────────dangling dep───────┴────────▶ COMPLETED
                          reconciliation          FAILED  CANCELLED
```

* `READY` is the *only* pre-execution state. "Executable" is a **derived
  predicate** (due ∧ deps), not a state — one fewer transition, one fewer bug.
* **Fail-safe blocking**: FAILED/CANCELLED deps never unblock dependents. A
  dependent of a failed task stays PENDING until the operator `updateTask`s its
  dependency list. Nothing auto-runs on a compromised precondition.
* **Dangling dependencies** (a dep is deleted after unblock): the claim path
  re-checks real dep state (O(d)) and reconciles the task back to PENDING with a
  recomputed unmet count. Blocked tasks are surfaced by `getBlockedTasks()`.
* Terminal states (COMPLETED/FAILED/CANCELLED) are immutable; transition table:

| from \ op | complete | fail | cancel | update | delete |
|-----------|----------|------|--------|--------|--------|
| PENDING / READY / RUNNING | → COMPLETED (RUNNING via normal path) | → FAILED | → CANCELLED | PENDING/READY only; RUNNING throws | → removed |
| COMPLETED | no-op | **throws** | no-op | **throws** | → removed |
| FAILED | **throws** | no-op | no-op | **throws** | → removed |
| CANCELLED | **throws** | no-op | no-op | **throws** | → removed |

## 3. Data structures

| Structure | Shape | Purpose | Cost |
|-----------|-------|---------|------|
| `tasks` | `Map<string, Task>` | task records; O(1) by id | ~1 entry/task |
| `depsOf` | `Map<string, Set<string>>` | forward edges (deduplicated); unmet computation, DFS | O(E) |
| `dependents` | `Map<string, Set<string>>` | reverse edges; unblock fan-out on completion, O(1) per dependent | O(E) |
| `dueHeap` | binary heap, position map `id→index` | claim source; key (priority DESC, time ASC, seq ASC) | O(1) remove(id), O(log n) push/pop/heapify-O(n) |
| `futureHeap` | binary heap, position map | time gate + `nextWakeTime()`; key (time ASC, priority DESC, seq) | same |
| `unmetDependencies` | `number` per task | O(1) unblock test; maintained incrementally | O(1) |
| `sequence` | `number` per task | global creation counter; total-order tie-break (deterministic drain) | O(1) |

**Invariant (heap key stability):** a task in either heap has heap-key fields
(priority, executeTime, sequence) unchanged since insertion. `updateTask`
enforces it by removing the task from both heaps before mutating and re-inserting
if still READY.

**Custom `BinaryHeap`** (no library dep): comparator-driven min-heap with a
position map giving O(1)-locate + O(log n) arbitrary `remove(id)` (swap with
last, sift in whichever direction is needed). `heapify(arr)` is O(n) and powers
the batch path (`addTasks`) and the 1M load.

## 4. Complexity analysis

Let n = tasks, E = edges, d = a task's fan-in, k = number of affected dependents.

| Operation | Time | Notes |
|-----------|------|-------|
| `addTask` | O(d + log n) | dedupe + existence check O(d); one heap insert if READY. No cycle search needed: a brand-new node cannot lie on a cycle. |
| `addTasks` (k tasks) | O(Σd + k·log n) | 3-pass (ids → records → edges/status), heapify O(k). Intra-batch forward refs allowed; run `findCycle()` on untrusted sources. |
| `updateTask` (no dep change) | O(log n) | remove + re-insert (if READY). |
| `updateTask` (dep change) | O(Σ d + V + E + log n) | per new edge: reachability O(V+E) worst case, early exit; mutation O(d_in + d_out). |
| `claimNextExecutable` | **amortized O((p + s + 1)·log n)** | p = promotions this call (monotonic), s = stale discards. Steady state O(log n) + O(d) dep check. |
| `peekNextExecutable` | same, no status mutation | |
| `completeTask` | O(k + k·log n) | decrement k dependents' unmet; heap-insert those reaching 0. |
| `failTask` / `cancelTask` | O(log n) | heap remove only; dependents stay blocked (fail-safe). |
| `deleteTask` | O(d_in + d_out + log n) + O(n·d) recount | dependents keep their (now dangling) edge; inbound list retained so a re-add of the same id resumes unblock propagation (verified in tests). |
| `wouldCreateCycle` | O(V + E) worst, early exit | iterative DFS. |
| `hasCycle` / `findCycle` | O(V + E) time, O(V) stack | iterative 3-color DFS — 1M-deep chains cannot overflow the call stack (tested). |
| `nextWakeTime` | O(1) | futureHeap root. |
| `metrics` | O(1) | all counters maintained incrementally. |
| `getBlockedTasks` / `getExecutableTasks` | O(n·d) | diagnostics only — keep out of hot paths. |

**Why `claim` is amortized O(log n):** promotions are one-way (future→due) except
an explicit future-time update (which removes+re-inserts deliberately); stale
discards correspond to status changes that already paid O(log n). Neither p nor s
can be pumped per call in a steady-state workload. The adversarial "100k
high-priority future over 1 due task" case claims in O(log n) — measured, not
just argued.

## 5. Concurrency & clock model

* Single-threaded (JS): all operations are synchronous ⇒ atomic. `executeNextTask`
  is the only async path: the task sits RUNNING while the executor promise is
  pending; multiple workers can hold multiple RUNNING tasks.
* The clock is **monotonic by contract**. `claimNextExecutable(now)` /
  `peekNextExecutable(now)` advance it via `max(clock, now)`; a backward `now` is
  ignored and counted in `metrics().clockRegressionsIgnored` (NTP-style
  regression is a caller bug that must not corrupt heap placement).
* **Hooks** (`onTaskClaimed/Completed/Failed/Cancelled`) fire synchronously
  mid-transition. Order in `completeTask`: status → hook → unblock, so a hook
  re-entering the scheduler sees a consistent pre-unblock world.

## 6. Scalability discussion (1M → 10M)

**Measured on this machine (M3 Max, Node 22)** — see `tests/Performance.spec.ts`:

* 1M `addTask`: **2.1s** (482k adds/s), 199,999 edges.
* 1M full drain (claim + complete, all due now): **5.2s** (~194k ops/s), zero
  dependency-order violations, zero residual PENDING/READY.
* Adversarial claim (100k future high-priority over 1 due): **<1ms**, 0 promotions;
  burst-promoting all 100k after a clock jump: 87ms.
* `hasCycle()` over a 1M-node chain: **0.6s**, no stack overflow.
* Resident footprint of 1M tasks: **~555 MB after GC** (~608 MB after load,
  ~555–608 B/task including 20% with one dependency) — well inside a 1 GB budget;
  see the levers below for 10M.

**Where the memory goes (per task):** the Task object (~300–600 B in V8), a
`Map` entry (~60–100 B), a heap slot (8 B ref), one deps-`Set` entry per edge
(~50–100 B + id string). Ids dominate when long.

**Scaling levers (in order of payoff):**
1. **Payload externalization** — the scheduler stores payloads by reference only;
   in production, keep blobs (MBs) out of the heap entirely.
2. **Numeric ids** — `Map<number, _>` halves entry cost and removes string
   interning pressure; ids are API-level only, so this is a config concern.
3. **Typed-array heap keys** — store (priority, time, seq) in parallel
   `Float64Array`/`BigInt64Array` and heap over indices: heap becomes 3·8 B per
   task instead of object-ref churn; the `Map` stays the lookup. Worth it at 10M+.
4. **Sharding** — partition by priority band or execute-time range into multiple
   `TaskScheduler` instances behind a router; each shard stays in the O(log n)
   regime and shards can even live in worker threads (task graphs rarely cross
   shards by construction).
5. **Persistence offload** — the graph is plain JSON-shaped data; snapshot
   `tasks` + `depsOf` for crash recovery (out of scope here; the data layout
   makes it a serialization pass, not a redesign).
6. **GC-friendly batching** — `addTasks` already heapifies in O(k); for sustained
   >10M, consider arena allocation of Task records to cut GC pause tail latency.

**What does *not* scale:** `getBlockedTasks` (O(n·d)) — keep it a diagnostic, not
a polling loop; expose counts incrementally if operators need live dashboards.

## 7. Edge cases (all covered by tests)

* Duplicate ids, empty/whitespace ids, NaN/±Infinity priority & time.
* Unknown dependency → reject (no forward references by design — the graph is
  complete at edge-creation time; intra-batch forward refs are the documented
  exception in `addTasks`).
* Self-dependency → `CycleError` (add, batch, update).
* Long cycles: 1000-node ring rejected at the closing edge; 1M chain
  `hasCycle()` fast & iterative; `findCycle()` returns the closed path on a
  loaded cyclic graph while non-cyclic tasks remain executable (cycles never
  break the scheduler — they only block their members).
* Dangling deps: delete COMPLETED/PENDING predecessor → dependent re-blocks,
  surfaced in `getBlockedTasks()`; operator fixes via `updateTask`; delete→re-add
  of the same id resumes unblock propagation (reconciliation pass).
* Clock regression ignored & counted; same-tick adds FIFO via sequence.
* Terminal-state transition table (see §2) — including "complete a FAILED
  throws", "fail a COMPLETED throws".
* Fan-in 100: READY exactly on the 100th completion. Diamond: no double-unblock.
* 10k random DAG: topological invariant checked on every claim.
* 500-task mixed workload: every claim is the *max priority among executable*
  (optimality, not just validity).
* `maxTasks` capacity enforced per-add and per-batch (atomic: batch rejects
  before committing any task).
* Optimistic concurrency: `expectedVersion` mismatch → `StaleVersionError`.
