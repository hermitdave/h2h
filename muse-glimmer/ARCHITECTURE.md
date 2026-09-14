# In-Memory Task Scheduler — Architecture

## Goals
- Support 1M+ tasks in memory with low latency retrieval of next executable task.
- Priorities + execution timestamps.
- Dependency tracking with cycle detection.
- Dynamic updates (priority, time, dependencies) without full rebuild.
- Production-ready: thread-safe, observable, deterministic ordering.

## Core Design

### Data Model
```python
Task:
  id: str
  scheduled_time: int|float   # epoch ms
  priority: int               # lower = higher priority
  state: pending|ready|running|done|cancelled
  version: int                # for lazy heap invalidation
  data: Any
```

### Structures
1. **tasks**: dict[id -> Task]  O(1) lookup
2. **dependencies**: dict[id -> set[id]]  prereqs
3. **dependents**: dict[id -> set[id]]  reverse index for fast indegree updates
4. **indegree**: dict[id -> int]  number of unresolved prereqs
5. **ready_heap**: heapq of (scheduled_time, priority, version, id)
   - Only tasks with indegree == 0 and scheduled_time <= now are pushed.
   - Lazy deletion via version check.
6. **future_heap**: heapq of (scheduled_time, priority, version, id)
   - Tasks with indegree == 0 but scheduled_time > now.
7. **time_index**: optional sorted container for bulk time wakeups. Heaps suffice.

All structures are plain dicts/heapq for minimal overhead ~ 200 bytes/task → ~200MB for 1M tasks, acceptable in-memory.

### Operations

**add_task(task)**
- Insert into tasks, indegree=0.
- If dependencies provided, validate existence, update graph, run cycle detection.
- Push to future_heap or ready_heap based on time.

**add_dependency(task_id, depends_on_id)**
- Add edge depends_on_id -> task_id.
- Increment indegree, move task out of ready if present.
- Cycle detection: BFS/DFS from task_id following dependents to see if depends_on_id reachable. O(k) where k is reachable subgraph, early exit.
- If cycle → raise CycleError.

**update_task(task_id, *, scheduled_time, priority)**
- Bump version, update fields.
- Re-evaluate placement between ready/future heaps.
- No graph change → no cycle check.

**complete_task(task_id)**
- Set state done.
- For each dependent, decrement indegree, if zero → promote to ready/future based on time.

**get_next_task(now)**
- Drain future_heap: move tasks whose scheduled_time <= now to ready_heap.
- Clean top of ready_heap until version matches and state is ready.
- Return task and mark running. O(log n) amortized.

### Dynamic Updates
Versioned heap entries avoid O(n) re-heapify. On update, push new entry; stale entries discarded on pop.

Dependency updates are O(degree) + cycle check. Updates to priority/time are O(log n).

### Cycle Detection
Incremental: on edge addition B -> A, check if A reaches B via dependents graph.
Use iterative stack with visited set capped to avoid full graph scans. For dense graphs, worst case O(V+E). In practice dependencies are sparse.

Alternative for high churn: maintain topological order with dynamic algorithm, but complexity outweighs benefit for typical workloads.

### Thread Safety
Public API guarded by RLock. All heap operations are local and fast.

### Complexity
- add_task: O(d + log n) where d = dependency count
- add_dependency: O(d + cycle_check)
- complete_task: O(deg * log n)
- get_next_task: O(log n) amortized
- Memory: O(n + e)

### Scalability Notes
- 1M tasks → dicts ~ 150-250MB. Heaps ~ 80MB. Acceptable on 64GB host.
- Hot path is heap push/pop: <1µs per op in CPython.
- For >10M tasks, shard by partition or move to persistent store + LSM tree.
- For distributed scheduling, replace in-memory structures with Redis Sorted Sets + adjacency in graph DB.
- Monitor heap size, stale entry ratio, cycle detection latency.

### Failure Modes
- Cycle on dependency add → reject, keep previous state.
- Duplicate task id → reject.
- Complete unknown task → ignore or raise.
- Time drift → get_next_task called periodically, future heap drains lazily.
