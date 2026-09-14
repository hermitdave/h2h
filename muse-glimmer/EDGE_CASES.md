# Edge Cases

## Task Lifecycle
- add_task with existing id → SchedulerError
- add_task with dependencies on unknown ids → SchedulerError
- add_dependency creates self-dependency → CycleError
- add_dependency creates indirect cycle → CycleError, state unchanged
- complete_task called twice → idempotent
- cancel_task after running → state becomes cancelled, heap entry invalidated via version bump
- get_next_task with now < earliest scheduled_time → returns None, heap unchanged

## Priority & Time
- priority ties: lower numeric value wins; tie-break by scheduled_time then id for determinism
- scheduled_time negative: treated as immediate
- update_task changes priority/time of running task → ignored (state check)
- update_task while task pending → version bump, new entry pushed, old entry lazily discarded

## Dependencies
- Multiple parents: indegree counts all, task ready only when all completed
- Diamond dependency: works, indegree decrements correctly
- Adding dependency to ready task → task reverts to pending, removed from heap via version bump
- Removing dependency not supported in v1; requires version bump and indegree recompute — design decision to keep API simple

## Concurrency
- RLock ensures atomicity of graph updates + heap pushes
- get_next_task marks task running atomically, preventing double dispatch
- High churn: stale heap entries accumulate; periodic heap rebuild if stale ratio > 30%

## Memory & Performance
- 1M tasks: ~500MB RAM, acceptable
- Heap contains only ready tasks → size bounded by ready set, not total tasks
- Future tasks with scheduled_time > now stay in heap but skipped until time passes → O(log n) scan per get_next_task

## Failure Scenarios
- Process crash → in-memory state lost; requires snapshot + write-ahead log for durability
- Clock skew: use monotonic clock for now parameter, not system time
- Dependency graph disconnected: scheduler still works, tasks processed independently

## Production Considerations
- Metrics needed: pending/ready counts, heap size, cycle check latency, version churn
- Observability: log cycle detection failures, invalid state transitions
- Testing: property-based tests for ordering invariants under random updates
- Backpressure: max task limit, reject or queue
