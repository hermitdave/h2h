# H2H Model Evaluation Summary

## Ornith 1.5 MoE — Task Scheduler

**Date:** 2026-09-11
**Prompt:** Production-ready in-memory task scheduler (1M tasks, priorities, timestamps, dependency tracking, dynamic updates, cycle detection, efficient retrieval)

---

## Ratings

| Category | Score | Max |
|----------|-------|-----|
| Architecture & Design | 8 | 10 |
| Data Structures | 9 | 10 |
| Correctness | 9 | 10 |
| Complexity (Actual vs Claimed) | 9 | 10 |
| Completeness (Feature Coverage) | 8 | 10 |
| Edge Cases Handled | 8 | 10 |
| Scalability Discussion | 6 | 10 |
| Code Quality & Readability | 9 | 10 |
| Test Quality | 8 | 10 |
| Production Readiness | 7 | 10 |
| **Overall** | **8.1** | **10** |

---

## Architecture & Design

**Strengths:**
- Clean single-heap design with lazy tombstoning (`heap_mark`)
- Bidirectional adjacency lists (`_watchers` for dependents, `task.deps` for unresolved deps)
- Rich state machine: PENDING → RUNNING → DONE/FAILED/CANCELLED/DEPRECATED + WAITING
- Cascade failure semantics (failed parent propagates to dependents)
- `TaskInput` DTO for clean API separation
- UUID-based auto IDs with monotonic `rseq` for tie-breaking
- Best-effort timer support (`arm_timer` / `disarm_timer`)
- `dump()` for operational diagnostics

**Weaknesses:**
- Single-consumer model (not thread-safe by design)
- Priority range hardcoded to 11 levels `[-5, 5]`
- Timer support is decorative, not functional

---

## Data Structures

**Strengths:**
- `_HeapEntry` tuple `(due, -priority, rseq, tid)` — strict total order without object comparison
- `heap_mark` for O(1) stale-entry detection (lazy deletion)
- `Set[str]` for unresolved deps (pruned as deps complete)
- `List[str]` for watchers (dependents)

**Weaknesses:**
- None significant

---

## Correctness Issues

**None found.** All 4 test failures are test design bugs, not code bugs.

1. `test_multiple_dependencies_all_required` — test assertion is incorrect; code correctly waits for all deps
2. `test_dependent_on_done_parent_starts_immediately` — test calls `done_task` on PENDING task without `next_task`; code correctly raises RuntimeError
3. `test_three_node_cycle_rejected_and_schedule_untouched` — test setup doesn't create the claimed cycle; code correctly allows the update
4. `test_update_dependency_change_promotes_child` — test expects `b` but `a` wins by insertion order; code is correct

---

## Test Quality

**Strengths:**
- 55 tests, 51 pass (93%)
- Full state transition matrix tested
- Dependency chains, branching, cascades
- Cycle detection (self, 2-node, 3-node)
- Dynamic updates
- Edge cases

**Weaknesses:**
- 4 tests have incorrect expectations
- No 1M-task test
- No concurrency tests
- No memory tests

---

## Production Readiness Assessment

**Most production-ready of the four models.** Single-consumer model is a legitimate design choice (matching Quartz/Sidekiq patterns). Correctness is excellent. The main gaps are:
- No thread safety (documented)
- No persistence
- No operational metrics

---

## Key Metrics

- Test count: 55
- Pass rate: 51/55 (93%)
- 1M insert time: 4.50s (222,382/s)
- 1M execute time: 1.20s (834,411/s)
- LOC (implementation): 631 (scheduler) + 180 (task) + 26 (errors) = 837
- LOC (tests): 612

---

## Verdict

The best model of the four. Clean architecture, excellent performance, correct behavior on all tested scenarios. The test suite is comprehensive but has 4 incorrect expectations. If those tests are fixed, this would score 9+/10.
