# Complexity Analysis

## Operations
- add_task: O(d + log n) where d = number of dependencies, log n for heap push
- add_dependency: O(cycle_check + log n). Cycle check is O(k) where k is reachable subgraph size, early exit typical.
- update_task: O(log n) — version bump + heap push
- complete_task: O(deg * log n) for dependents promotion
- get_next_task: O(log n) amortized — heap pop with lazy invalidation

## Memory
- tasks dict: ~72 bytes + Task object ~56 + fields → ~200 bytes/task
- dependencies/dependents: edges stored twice → ~72 bytes/edge
- heap: 4-tuple per ready task → ~72 bytes

For 1M tasks with avg 2 deps:
- Tasks ~200 MB
- Edges ~144 MB
- Heap ~72 MB
Total < 500 MB, fits in 64GB host with headroom.

## Scalability Discussion

### Throughput
Heap push/pop is ~0.5-1 µs in CPython for 1M items. get_next_task can sustain >1M ops/sec single-threaded.

### Concurrency
RLock allows single-threaded writers with many readers. For high write contention, shard by task_id hash across multiple scheduler instances.

### 1M+ tasks
- Use __slots__ on Task to reduce memory 30-40%.
- Store scheduled_time as int ms to avoid float overhead.
- Use array-based heap (heapq) — already optimal.
- Consider priority as small int for faster tuple compare.

### Dynamic updates
Versioned entries avoid O(n) re-heapify. Stale entry ratio stays low (<5%) under normal churn.

### Cycle detection
Incremental DFS is fine for sparse graphs. For dense graphs with frequent dependency changes, maintain topological order incrementally or batch updates.

### Failure modes
- Cycle creation → rejected atomically, state unchanged.
- Duplicate id → rejected.
- Complete of non-existent → error.
- Time drift → get_next_task called with monotonic clock; future tasks stay in heap.

### Production hardening
- Metrics: heap size, stale ratio, cycle check latency, indegree distribution.
- Observability: expose pending/ready counts, max indegree.
- Persistence: snapshot tasks dict + edges to disk periodically; replay log for recovery.
- Backpressure: limit max tasks, evict cancelled/completed tasks via background sweeper.
- Distributed: replace in-memory heaps with Redis Sorted Sets per priority shard; keep dependency graph in graph DB.

### Edge Cases
- Zero dependencies, scheduled_time in past → immediately ready.
- Priority ties → tie-break by scheduled_time then id for determinism.
- Update scheduled_time to past while task pending → promoted on next get_next_task.
- Complete task with dependents already completed → indegree underflow prevented by guard.
- Cancel task with dependents → dependents remain pending; consider cascade cancel policy.
- Add dependency after task already running → no effect; validate state.
