# H2H Model Evaluation Summary

## Nex N2.5 mini Run 2 — Task Scheduler

**Date:** 2026-09-11
**Prompt:** Production-ready in-memory task scheduler (1M tasks, priorities, timestamps, dependency tracking, dynamic updates, cycle detection, efficient retrieval)

---

## Ratings

| Category | Score | Max |
|----------|-------|-----|
| Architecture & Design | 5 | 10 |
| Data Structures | 3 | 10 |
| Correctness | 1 | 10 |
| Complexity (Actual vs Claimed) | 1 | 10 |
| Completeness (Feature Coverage) | 3 | 10 |
| Edge Cases Handled | 1 | 10 |
| Scalability Discussion | 2 | 10 |
| Code Quality & Readability | 4 | 10 |
| Test Quality | 1 | 10 |
| Production Readiness | 1 | 10 |
| **Overall** | **2.3** | **10** |

---

## ⚠️ REGRESSION FROM K2 HORIZON

This is a significant regression from K2 Horizon 36B MoVA (4.7). The model attempted a more sophisticated design but introduced fatal bugs.

---

## Architecture & Design

**Intended strengths:**
- Three-heap architecture: ready / due / blocked
- Lease tokens for claim safety
- Batch atomic updates
- Generic TaskId support
- Re-entrant lock with condition variables

**Actual state:**
- Missing attributes make the design unimplemented

---

## Correctness Issues

1. **CRITICAL: Missing `_ready_heap_by_id`, `_due_heap_by_id`, `_blocked_heap_by_id`** — referenced in `__init__` but never defined
2. **CRITICAL: `_validate_dependencies_available` signature mismatch** — called with 1 arg, needs 2
3. **CRITICAL: `_find_cycle_from_locked` IndexError** — `path.pop()` on empty list
4. **CRITICAL: `_place_ready_locked` references non-existent attributes**
5. **No capacity limit** despite 1M requirement

---

## Test Quality

**Strengths:**
- Tests concurrency, batch ops, lease semantics

**Weaknesses:**
- 13/14 tests fail
- No 1M-task test
- Tests prove the code is broken rather than validating functionality

---

## Production Readiness Assessment

**NOT production-ready.** The code cannot perform basic CRUD operations due to missing attributes and signature mismatches.

---

## Key Metrics

- Test count: 14
- Pass rate: 1/14 (7%)
- LOC (implementation): 913 (Python) + 1176 (C++) = 2089
- LOC (tests): 227

---

## Verdict

The worst-performing model. Attempted to build a sophisticated three-heap architecture with lease tokens but produced completely non-functional code. The C++ header (1176 lines) suggests the model may have prioritized the wrong implementation. A senior engineer would reject this immediately due to the missing attributes and signature mismatches.
