# H2H Model Evaluation Summary

## K2 Horizon 36B MoVA — Task Scheduler

**Date:** 2026-09-11
**Prompt:** Production-ready in-memory task scheduler (1M tasks, priorities, timestamps, dependency tracking, dynamic updates, cycle detection, efficient retrieval)

---

## Ratings

| Category | Score | Max |
|----------|-------|-----|
| Architecture & Design | 9 | 10 |
| Data Structures | 9 | 10 |
| Correctness | 2 | 10 |
| Complexity (Actual vs Claimed) | 4 | 10 |
| Completeness (Feature Coverage) | 8 | 10 |
| Edge Cases Handled | 4 | 10 |
| Scalability Discussion | 5 | 10 |
| Code Quality & Readability | 8 | 10 |
| Test Quality | 3 | 10 |
| Production Readiness | 1 | 10 |
| **Overall** | **4.7** | **10** |

---

## Architecture & Design

**Strengths:**
- Excellent two-heap architecture: `ready_heap` (executable-now) + `future_heap` (pending deps or future run_at)
- Bidirectional adjacency lists with `_ready_pos` map for O(log n) updates
- Rich state machine: PENDING → READY → RUNNING → DONE/FAILED/CANCELLED
- Thread-safe with `threading.Lock()` (single-writer, multiple-reader model)
- Injectable clock (`_CLOCK`) for deterministic testing
- Lazy tombstoning with monotonic generation counter
- Comprehensive docstrings explaining design rationale
- GC/maintenance method for purging tombstones

**Weaknesses:**
- Cycle detection budget guard silently returns instead of raising
- No persistence or checkpointing
- No metrics/observability hooks

---

## Data Structures

**Strengths:**
- `_ready_pos: Dict[int, int]` for O(1) heap position lookups
- `heapq` with custom `_ReadyEntry` / `_FutureEntry` dataclasses
- `set[int]` for dependents adjacency
- Tuple for immutable deps (hashable, memory-efficient)

**Weaknesses:**
- `@dataclass(frozen=True)` on `TaskState` enum is catastrophic (see Correctness)

---

## Correctness Issues

1. **CRITICAL: `@dataclass(frozen=True)` on Enum** — generates `__eq__` comparing fields (all empty), so all `TaskState` values compare equal. `in` checks break everywhere.
2. **CRITICAL: `update_task` always raises** — `if ref.state in (RUNNING, DONE, FAILED, CANCELLED)` is always True for PENDING.
3. **CRITICAL: `len()` always returns 0** — `_alive_count` filter `not in (CANCELLED, DONE, FAILED)` is always False.
4. **CRITICAL: `__contains__` broken** — `remove_task` doesn't remove from `self._tasks`, so `1 not in s` is False after removal.
5. **Bug: `remove_task` dependents not updated** — captures dependents AFTER popping from `_dependents`, so `dep_remaining` never decrements.
6. **Bug: Cycle detection budget** — silently returns instead of raising when budget exceeded.
7. **Bug: Benchmark crashes** — `randrange(0)` when `i=0`.

---

## Test Quality

**Strengths:**
- Well-organized test classes
- Randomized property tests (topological order verification)
- Concurrency tests
- Seeded randomness

**Weaknesses:**
- 22/30 tests fail
- Incorrect test expectations (`test_simple_cycle` expects valid dep to raise)
- No performance assertions
- No memory tests
- Benchmark broken

---

## Production Readiness Assessment

**NOT production-ready.** The `@dataclass(frozen=True)` on `TaskState` is a single-decorator bug that renders the entire system non-functional. Even if fixed, the insert rate (~1,200 tasks/s) is too slow for the 1M target, and the cycle detection budget guard is a correctness risk.

---

## Key Metrics

- Test count: 30
- Pass rate: 8/30 (27%)
- 50k insert time: 42.32s (~1,182 tasks/s)
- 1M extrapolated: ~845s (14 min) — too slow
- LOC (implementation): 462
- LOC (tests): 362

---

## Verdict

The best architecture of the two models, but the worst execution. The two-heap design with `_ready_pos` indexing is exactly what Kat Coder 2.5 was missing. However, a single decorator (`@dataclass(frozen=True)` on an Enum) breaks the entire system so thoroughly that no core operation works. The tests are poorly designed (wrong expectations) and don't catch the critical bugs. If the enum bug were fixed, this would likely score 8+/10, but as submitted it's non-functional.
