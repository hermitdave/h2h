# Production-Ready In-Memory Task Scheduler

## Design Document

### 1. System Overview

A high-performance in-memory task scheduler designed to manage 1M+ tasks with:
- **Priority scheduling** — higher-priority tasks execute first among ready tasks
- **Time-based execution** — tasks only execute at or after their scheduled time
- **Dependency tracking** — DAG-based dependencies between tasks
- **Dynamic updates** — modify priorities and schedules at runtime
- **Cycle detection** — prevent circular dependencies via DFS
- **Efficient retrieval** — O(log n) amortized for next-task lookup

### 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                   TaskScheduler                      │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌────────────┐  ┌────────────┐  ┌───────────────┐  │
│  │ Time Heap  │  │ Ready Heap │  │  Task Registry │  │
│  │ (min-heap) │  │ (max-heap) │  │   (hash map)   │  │
│  │ time,id    │  │ -pri,time  │  │ id → Task      │  │
│  └─────┬──────┘  └─────┬──────┘  └───────┬───────┘  │
│        │               │                  │          │
│  ┌─────┴───────────────┴──────────────────┴───────┐  │
│  │              Dependency Graph                   │  │
│  │  pending_deps: id → set{id}                    │  │
│  │  dependents:    id → set{id}                   │  │
│  │  status:        id → TaskStatus                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─────────────────────────────────────────────────┐  │
│  │              Cycle Detector (DFS)                │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 3. Data Structures

| Structure | Type | Purpose | Key |
|-----------|------|---------|-----|
| `time_heap` | Binary min-heap | Tasks waiting for their time | `(execution_time, task_id)` |
| `ready_heap` | Binary max-heap | Tasks ready to execute | `(-priority, execution_time, task_id)` |
| `task_map` | Hash map | O(1) task lookup by ID | `task_id → Task` |
| `pending_deps` | Hash map of sets | Unsatisfied dependencies | `task_id → set{dep_ids}` |
| `dependents` | Hash map of sets | Reverse lookup: who depends on this task | `task_id → set{dependent_ids}` |
| `status` | Hash map | Current state of each task | `task_id → TaskStatus` |
| `heap_version` | Hash map | Lazy-deletion versioning | `task_id → version_count` |

**Task Data Structure** (using `__slots__` for memory efficiency):
```
Task:
  id: str                # Unique task identifier
  priority: int          # Higher = more important
  scheduled_time: float  # Unix timestamp for earliest execution
  dependencies: tuple[str]  # IDs of prerequisite tasks
  payload: Any           # User-defined task data
  status: TaskStatus     # Current state
  completion_time: float | None  # When task finished
  _execution_time: float | None  # Overridden execution time (lazy calc)
```

**Task States:**
```
PENDING → READY → EXECUTING → COMPLETED
    │          │           │
    │          │           ├──→ FAILED
    │          │           └──→ CANCELLED
    │          └──→ CANCELLED
    └──→ CANCELLED
```

### 4. Algorithm Details

#### 4.1 Adding a Task
1. Validate no duplicate ID
2. Check all dependencies exist
3. **Cycle detection**: DFS from new task's dependencies; if we reach the new task ID, reject
4. Create Task object, register in all data structures
5. If no dependencies → call `_activate_task()`
6. If dependencies → register in `pending_deps` and `dependents` maps

#### 4.2 Activating a Task (Dependency Met)
When a dependency completes:
1. Remove completed task from dependent's `pending_deps`
2. If dependent has no remaining dependencies:
   - Set `execution_time = max(scheduled_time, current_time)`
   - If `execution_time ≤ current_time` → push to `ready_heap`
   - Else → push to `time_heap`

#### 4.3 Retrieving Next Executable Task
1. `advance_ready_tasks(current_time)`: Move tasks from `time_heap` whose time has arrived to `ready_heap`
2. Pop from `ready_heap`, skipping stale entries (lazy deletion)
3. Mark task as EXECUTING and return

#### 4.4 Completing a Task
1. Mark task as COMPLETED with completion_time
2. For each dependent in `dependents[task_id]`:
   - Remove this task from dependent's `pending_deps`
   - If dependent now has zero pending deps → activate

#### 4.5 Cycle Detection (DFS)
```
function detectCycle(newTaskId, dependencies):
    visited = set()
    stack = dependencies.copy()
    
    while stack:
        current = stack.pop()
        if current == newTaskId:
            return true  // Cycle found
        if current in visited:
            continue
        visited.add(current)
        for dep in pending_deps.get(current, empty):
            stack.push(dep)
    
    return false
```

#### 4.6 Lazy Deletion Strategy
When a task's priority or schedule changes, or when a task is moved between heaps:
1. Increment `heap_version[task_id]` for the source heap
2. Push a new entry to the target heap with the updated version
3. On pop, compare the entry's version with the current version
4. If versions differ, the entry is stale — discard and continue

This avoids O(n) heap restructuring and keeps all operations at O(log n).

### 5. Complexity Analysis

| Operation | Time Complexity | Space Complexity | Notes |
|-----------|----------------|-----------------|-------|
| `add_task()` | O(log n + d) | O(n + d) | d = dependency count, heap push + DFS |
| `get_next_task()` | O(log n) amortized | O(1) | Heap pop; amortized over lazy-deletion skips |
| `complete_task()` | O(k log n) | O(1) | k = number of dependents; each may need heap push |
| `fail_task()` | O(1) | O(1) | Status update only |
| `cancel_task()` | O(k) | O(1) | k = total dependents to cascade |
| `update_task()` | O(log n) | O(1) | Push new heap entry, stale old |
| `_check_cycles()` | O(v + e) | O(v) | DFS over dependency subgraph |
| `get_status()` | O(1) | O(1) | Hash map lookup |
| `get_ready_count()` | O(n) | O(1) | Iterates task map (can be O(1) with counter) |

**Legend:** n = total tasks, d = task dependency count, v = vertices in DFS, e = edges in DFS subgraph, k = dependents.

**Overall space:** O(n + d) where d is total dependency edges across all tasks.
With __slots__, each Task uses ~120 bytes. 1M tasks ≈ 120 MB + overhead ≈ ~200 MB.

### 6. Edge Cases & Error Handling

| Scenario | Handling |
|----------|----------|
| Self-dependency (A depends on A) | Cycle detection catches it |
| Circular dependency (A→B→C→A) | DFS detects cycle before insertion |
| Duplicate task ID | ValueError raised |
| Missing dependency | ValueError — dependency must be added first |
| Completing non-executing task | ValueError — guard check |
| Cancelling non-existent task | KeyError |
| Updating non-existent task | KeyError |
| Retrieving next task when none ready | Returns None (not an error) |
| Task added with past scheduled_time | Activated immediately if no deps |
| Priority tie-breaking | Deterministic by (execution_time, task_id) |
| Task depends on already-completed task | On dependency addition, check completion status and activate |
| Dependency removed before task added | Handled gracefully (no registration needed) |
| Large dependency fan-out (1 task depended on by 100k tasks) | complete_task() is O(k log n) — linear in fan-out |
| Task cancelled while executing | Status check prevents mid-execution cancellation |
| Re-adding a completed task | Must use a new ID — status checked |

### 7. Scalability Discussion

#### 7.1 Handling 1 Million Tasks

- **Memory**: ~200 MB for task data structures alone. The heaps add O(n) each (~16 bytes per entry for the tuple, plus Python object overhead). Total estimated ~500 MB, well within modern server memory.
- **Speed**: Adding 1M tasks in topological order (no cycles) with ~5 deps each: ~1-2 seconds. `get_next_task()` remains O(log n) ≈ 20 comparisons regardless of scale.
- **Dependency fan-out**: A single task completed by 100k dependents triggers 100k `O(log n)` heap pushes. At 1M tasks, worst-case fan-out is bounded by total edge count, which is manageable if well-distributed.

#### 7.2 Bottlenecks & Mitigations

1. **Cycle detection on insert**: O(V+E) per insert. For dense dependency graphs, this becomes costly.
   - *Mitigation*: Use incremental cycle detection (e.g., maintaining topological sort order) for bulk inserts.
   - *Mitigation*: Batch validation — collect all new tasks, validate cycles once at commit time.

2. **Lazy deletion heap bloat**: Stale entries accumulate. In steady state, heap size = n + number of updates.
   - *Mitigation*: Periodic heap compaction (O(n log n)) when heap size exceeds 2× n.
   - *Mitigation*: Use a supporting heap structure (e.g., lazy delete + lazy rebuild).

3. **Dependency fan-out**: Single task completion activating many dependents.
   - *Mitigation*: Use priority queues per task group, or limit concurrency with worker pools.
   - *Mitigation*: Group dependents into batches for processing.

#### 7.3 Concurrency

The current implementation is single-threaded. For concurrent access:
- **Read locks**: Per-task or per-group read locks for concurrent `get_next_task()`
- **Write locks**: Mutex around dependency updates in `complete_task()`
- **Alternative**: Use an actor model where each task has its own mutex, and dependency resolution sends messages

#### 7.4 Persistence

As an in-memory system, durability is not provided. For persistence:
- **Append-only log**: Log all state transitions to a WAL (Write-Ahead Log)
- **Checkpointing**: Periodic snapshots of the entire state to disk
- **Recovery**: Replay log from last checkpoint on restart

#### 7.5 Comparison with Alternatives

| Feature | This Design | Redis (ZSET) | Celery | Kubernetes Jobs |
|---------|-------------|--------------|--------|-----------------|
| Latency | O(log n) | O(log n) | O(ms) | O(s) |
| Dependencies | Built-in | Custom | Limited | Limited |
| Scale | 1M+ in-memory | 10M+ | 100K+ | 10K+ |
| Complexity | Low | Medium | High | High |
| Durability | None | Optional | Yes | Yes |

### 8. Production Considerations

1. **Thread safety**: Add `threading.Lock` around state mutations for multi-threaded access
2. **Monitoring**: Track metrics (ready count, pending count, avg wait time, cycle rejection rate)
3. **Backpressure**: Limit pending tasks to prevent memory exhaustion
4. **Deadlock prevention**: Timeout on tasks stuck in EXECUTING state
5. **Audit trail**: Log all state transitions for debugging
6. **Graceful shutdown**: Drain ready tasks, wait for executing tasks, then stop
