#!/usr/bin/env python3
"""
Unit tests for InMemoryScheduler.

Run:  python3 -m pytest test_scheduler.py -v
"""

import random
import pytest
from scheduler import (
    InMemoryScheduler, TaskSpec, TaskState,
    DependencyCycleError, TaskNotFoundError, DuplicateTaskError,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_sched(now=0.0):
    sched = InMemoryScheduler()
    # pin the clock for deterministic tests
    import scheduler as s
    s._CLOCK[0] = now
    return sched

def t(uid, run_at=0.0, prio=0, deps=()):
    return TaskSpec(uid=uid, name=f"t{uid}", run_at=run_at, priority=prio, deps=deps)


# ---------------------------------------------------------------------------
# Basic insertion & retrieval ordering
# ---------------------------------------------------------------------------

class TestInsertionOrdering:
    def test_simple_priority_order(self):
        s = make_sched()
        s.add_task(t(1, prio=5))
        s.add_task(t(2, prio=9))
        s.add_task(t(3, prio=1))
        assert s.pop_next() is not None and s.pop_next().uid == 2
        assert s.pop_next().uid == 1
        assert s.pop_next().uid == 3
        assert s.pop_next() is None

    def test_run_at_respected(self):
        s = make_sched(now=10.0)
        s.add_task(t(1, run_at=20.0))
        assert s.peek_next().uid == 1
        # advance clock
        import scheduler as sc
        sc._CLOCK[0] = 20.0
        assert s.pop_next().uid == 1

    def test_run_at_then_priority(self):
        """Earlier run_at always wins, regardless of priority."""
        s = make_sched()
        s.add_task(t(1, run_at=5.0, prio=999))
        s.add_task(t(2, run_at=1.0, prio=0))
        assert s.pop_next().uid == 2
        assert s.pop_next().uid == 1

    def test_tie_break_by_uid(self):
        s = make_sched()
        s.add_task(t(3, prio=7))
        s.add_task(t(1, prio=7))
        s.add_task(t(2, prio=7))
        assert s.pop_next().uid == 1
        assert s.pop_next().uid == 2
        assert s.pop_next().uid == 3


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

class TestDependencies:
    def test_dep_unblocks_after_done(self):
        s = make_sched()
        s.add_task(t(1))                 # the dep
        s.add_task(t(2, deps=(1,)))      # waits on 1
        # 2 must NOT be executable while 1 is pending
        assert s.peek_next().uid == 1
        spec = s.pop_next()
        assert spec.uid == 1
        s.mark_done(1)                   # completing 1 unblocks 2
        assert s.peek_next().uid == 2
        s.pop_next()
        s.mark_done(2)

    def test_chain_dependency(self):
        s = make_sched()
        for i in range(1, 6):
            s.add_task(t(i, deps=tuple(range(1, i))))
        assert s.peek_next().uid == 1
        s.pop_next(); s.mark_done(1)
        assert s.peek_next().uid == 2
        s.pop_next(); s.mark_done(2)
        # 3 needs both 1 and 2
        assert s.peek_next().uid == 3

    def test_branching_dependencies(self):
        s = make_sched()
        s.add_task(t(1)); s.add_task(t(2))
        s.add_task(t(3, deps=(1, 2)))
        assert s.peek_next().uid in (1, 2)
        done = s.pop_next(); s.mark_done(done.uid)
        other = s.pop_next(); s.mark_done(other.uid)
        assert s.peek_next().uid == 3

    def test_failed_dep_blocks_dependent(self):
        s = make_sched()
        s.add_task(t(1))
        s.add_task(t(2, deps=(1,)))
        s.pop_next(); s.mark_failed(1)   # failed dep → dependent stays blocked
        assert s.peek_next() is None
        # recovery: cancel the dependent
        s.remove_task(2)

    def test_remove_unblocks_dependent(self):
        """Removing a dependency should *not* auto-unblock — caller must decide.
        We document the semantic: removal is explicit cancellation of the dep
        edge, so the dependent's dep counter decrements. If that hits zero the
        dependent becomes schedulable."""
        s = make_sched()
        s.add_task(t(1))
        s.add_task(t(2, deps=(1,)))
        s.remove_task(1)
        # dep counter for 2 went 1 → 0, so 2 is now schedulable
        assert s.peek_next().uid == 2

    def test_multiple_deps_all_must_complete(self):
        s = make_sched()
        for i in range(1, 4):
            s.add_task(t(i))
        s.add_task(t(4, deps=(1, 2, 3)))
        done = set()
        for _ in range(3):
            spec = s.pop_next()
            done.add(spec.uid)
            s.mark_done(spec.uid)
        assert s.peek_next().uid == 4
        s.pop_next(); s.mark_done(4)


# ---------------------------------------------------------------------------
# Dynamic updates
# ---------------------------------------------------------------------------

class TestUpdates:
    def test_update_priority_reorders(self):
        s = make_sched()
        s.add_task(t(1, prio=1))
        s.add_task(t(2, prio=1))
        s.update_task(1, priority=99)
        assert s.pop_next().uid == 1

    def test_update_run_at_defers(self):
        s = make_sched(now=0.0)
        s.add_task(t(1, run_at=5.0))
        import scheduler as sc
        sc._CLOCK[0] = 0.0
        assert s.pop_next() is None       # not yet runnable
        sc._CLOCK[0] = 5.0
        assert s.pop_next().uid == 1

    def test_update_run_at_to_past_rereads(self):
        s = make_sched(now=10.0)
        s.add_task(t(1, run_at=50.0))
        import scheduler as sc
        sc._CLOCK[0] = 0.0
        # not in ready heap because run_at in future → it's in future_heap
        sc._CLOCK[0] = 10.0
        s.update_task(1, run_at=5.0)      # now it's in the past
        sc._CLOCK[0] = 0.0                # rewind! it should pop
        assert s.pop_next().uid == 1

    def test_update_readd_requires_state_READY(self):
        # updating a task that is PENDING (not yet pushed) should be a no-op-ish
        s = make_sched(now=0.0)
        s.add_task(t(1, run_at=100.0))    # lands in future_heap
        s.update_task(1, priority=50)     # state PENDING → no relocate needed
        import scheduler as sc
        sc._CLOCK[0] = 0.0
        assert s.pop_next() is None       # still future


# ---------------------------------------------------------------------------
# Removals
# ---------------------------------------------------------------------------

class TestRemovals:
    def test_remove_pending(self):
        s = make_sched()
        s.add_task(t(1))
        s.remove_task(1)
        assert 1 not in s
        assert s.pop_next() is None

    def test_remove_ready(self):
        s = make_sched()
        s.add_task(t(1))
        s.remove_task(1)
        assert s.pop_next() is None

    def test_remove_dependent_unblocks_others(self):
        s = make_sched()
        s.add_task(t(1))
        s.add_task(t(2, deps=(1,)))
        s.add_task(t(3, deps=(1,)))
        s.remove_task(1)
        assert s.peek_next() is not None

    def test_remove_running_raises(self):
        s = make_sched()
        spec = s.pop_next()
        with pytest.raises(ValueError):
            s.remove_task(spec.uid)

    def test_remove_nonexistent_raises(self):
        s = make_sched()
        with pytest.raises(TaskNotFoundError):
            s.remove_task(999)

    def test_duplicate_insert_raises(self):
        s = make_sched()
        s.add_task(t(1))
        with pytest.raises(DuplicateTaskError):
            s.add_task(t(1))


# ---------------------------------------------------------------------------
# Cycle detection
# ---------------------------------------------------------------------------

class TestCycles:
    def test_self_cycle(self):
        s = make_sched()
        with pytest.raises(DependencyCycleError):
            s.add_task(t(1, deps=(1,)))

    def test_simple_cycle(self):
        s = make_sched()
        s.add_task(t(1))
        with pytest.raises(DependencyCycleError):
            s.add_task(t(2, deps=(1,)))
        with pytest.raises(DependencyCycleError):
            s.add_task(t(1, deps=(2,)))   # re-adding 1 with dep on 2 → cycle

    def test_indirect_cycle(self):
        s = make_sched()
        s.add_task(t(1))
        s.add_task(t(2, deps=(1,)))
        with pytest.raises(DependencyCycleError):
            s.add_task(t(1, deps=(2,)))   # 1 ↔ 2 cycle

    def test_longer_cycle(self):
        s = make_sched()
        s.add_task(t(1))
        s.add_task(t(2, deps=(1,)))
        s.add_task(t(3, deps=(2,)))
        with pytest.raises(DependencyCycleError):
            s.add_task(t(1, deps=(3,)))   # 1→2→3→1

    def test_acyclic_after_retry(self):
        s = make_sched()
        s.add_task(t(1))
        s.add_task(t(2, deps=(1,)))
        # adding a bad dep must not corrupt the graph
        with pytest.raises(DependencyCycleError):
            s.add_task(t(1, deps=(2,)))
        assert s.pop_next().uid == 1
        s.mark_done(1)
        assert s.pop_next().uid == 2


# ---------------------------------------------------------------------------
# Concurrency / snapshots
# ---------------------------------------------------------------------------

class TestConcurrency:
    def test_single_writer_multiple_readers(self):
        """The scheduler uses an internal lock — concurrent pops must not
        corrupt the heaps (we simulate interleaved calls)."""
        s = make_sched()
        for i in range(1000):
            s.add_task(t(i))
        # concurrent pops from multiple "threads"
        results = []
        for i in range(100):
            spec = s.pop_next()
            if spec:
                results.append(spec.uid)
                s.mark_done(spec.uid)
        assert len(results) == 100
        assert len(set(results)) == 100   # no duplicates

    def test_len_is_stable(self):
        s = make_sched()
        for i in range(500):
            s.add_task(t(i))
        assert len(s) == 500
        s.remove_task(10)
        assert len(s) == 499
        s.add_task(t(500))
        assert len(s) == 500


# ---------------------------------------------------------------------------
# Randomized / property tests (seeded)
# ---------------------------------------------------------------------------

class TestRandomized:
    def test_random_dependency_graph_no_cycle(self):
        """A random DAG of 500 tasks must execute in a valid topological order."""
        random.seed(1234)
        s = make_sched()
        n = 500
        for i in range(n):
            # only depend on earlier ids → guarantees acyclic
            k = random.randint(0, min(5, i))
            deps = tuple(random.sample(range(i), k)) if i else ()
            s.add_task(t(i, deps=deps))

        executed = set()
        # drain
        while True:
            spec = s.pop_next()
            if spec is None:
                break
            # every dep must have been executed already
            for d in spec.deps:
                assert d in executed, f"dep {d} of {spec.uid} ran early"
            executed.add(spec.uid)
            s.mark_done(spec.uid)

        assert len(executed) == n

    def test_randomized_insert_then_full_drain(self):
        random.seed(99)
        s = make_sched(now=0.0)
        n = 2000
        for i in range(n):
            deps = tuple(random.randrange(i) for _ in range(random.randint(0, 3)))
            s.add_task(t(i, run_at=random.uniform(0, 100), prio=random.randint(0, 50), deps=deps))
        seen = 0
        while s.pop_next() is not None:
            seen += 1
        assert seen == n

    def test_stress_update_during_drain(self):
        """Interleave priority bumps while draining — heap must stay valid."""
        s = make_sched(now=0.0)
        for i in range(1000):
            s.add_task(t(i, prio=0))
        for _ in range(5000):
            spec = s.pop_next()
            if spec is None:
                break
            s.mark_done(spec.uid)
            # bump a random task's priority
            uid = random.randrange(1000)
            if uid in s:
                s.update_task(uid, priority=random.randint(0, 1000))
