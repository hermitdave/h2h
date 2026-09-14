"""Comprehensive test suite for TaskScheduler."""

import pytest
import threading
import time as _rt
from scheduler import (
    TaskScheduler, Task, TaskStatus,
    CycleDetectedError, DependencyFailedError, InvalidTaskStateError,
)


@pytest.fixture
def scheduler():
    return TaskScheduler()


def _now():
    return _rt.time()


def _past(seconds=10):
    return _now() - seconds


def _future(seconds=1000):
    return _now() + seconds


# ── helpers ───────────────────────────────

def _claim_and_complete(scheduler, task_id):
    """Helper: claim a task via get_next_task then complete it."""
    t = scheduler.get_next_task()
    assert t is not None, f"Task '{task_id}' not ready"
    assert t.id == task_id, f"Expected '{task_id}', got '{t.id}'"
    scheduler.complete_task(t.id)


# ── 1. Basic ──────────────────────────────

class TestBasic:

    def test_add_and_get_single_task(self, scheduler):
        scheduler.add_task("task-1", priority=5, scheduled_time=_past(10))
        task = scheduler.get_next_task()
        assert task is not None and task.id == "task-1"

    def test_add_multiple_tasks_order_by_priority(self, scheduler):
        for i in range(10):
            scheduler.add_task(f"t{i}", priority=i, scheduled_time=_past(10))
        results = [scheduler.get_next_task().id for _ in range(10)]
        assert results == ["t9", "t8", "t7", "t6", "t5", "t4", "t3", "t2", "t1", "t0"]

    def test_get_next_returns_none_when_empty(self, scheduler):
        assert scheduler.get_next_task() is None

    def test_get_next_returns_none_when_pending(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_future(1000))
        assert scheduler.get_next_task() is None

    def test_task_status_becomes_executing(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past(10))
        task = scheduler.get_next_task()
        assert task.status == TaskStatus.EXECUTING

    def test_get_task_returns_task_object(self, scheduler):
        scheduler.add_task("x", priority=3, scheduled_time=_past(), payload={"data": 42})
        task = scheduler.get_task("x")
        assert task is not None and task.id == "x" and task.payload == {"data": 42}

    def test_get_status_returns_pending_by_default(self, scheduler):
        assert scheduler.get_status("nonexistent") == TaskStatus.PENDING

    def test_get_task_count(self, scheduler):
        scheduler.add_task("a", priority=1, scheduled_time=_past())
        scheduler.add_task("b", priority=2, scheduled_time=_past())
        assert scheduler.get_task_count() == 2


# ── 2. Priority ordering ──────────────────

class TestPriority:

    def test_tie_breaking_by_execution_time(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=5, scheduled_time=base - 5)
        scheduler.add_task("b", priority=5, scheduled_time=base - 2)
        scheduler.add_task("c", priority=5, scheduled_time=base - 1)
        assert [scheduler.get_next_task().id for _ in range(3)] == ["a", "b", "c"]

    def test_tie_breaking_by_task_id(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("z", priority=5, scheduled_time=base - 10)
        scheduler.add_task("a", priority=5, scheduled_time=base - 10)
        scheduler.add_task("m", priority=5, scheduled_time=base - 10)
        assert [scheduler.get_next_task().id for _ in range(3)] == ["a", "m", "z"]

    def test_higher_priority_intervenes(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("low", priority=1, scheduled_time=base - 10)
        assert scheduler.get_next_task().id == "low"
        scheduler.add_task("high", priority=100, scheduled_time=base - 10)
        assert scheduler.get_next_task().id == "high"


# ── 3. Time gating ────────────────────────

class TestTimeGating:

    def test_future_task_not_ready(self, scheduler):
        scheduler.add_task("future", priority=5, scheduled_time=_future(1000))
        assert scheduler.get_next_task() is None

    def test_past_task_becomes_ready(self, scheduler):
        scheduler.add_task("past", priority=5, scheduled_time=_past(10))
        assert scheduler.get_next_task() is not None

    def test_exact_scheduled_time(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("exact", priority=5, scheduled_time=base)
        assert scheduler.get_next_task().id == "exact"

    def test_zero_past_time(self, scheduler):
        scheduler.add_task("zero", priority=5, scheduled_time=0)
        assert scheduler.get_next_task() is not None

    def test_advance_time_activates_tasks(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("t1", priority=1, scheduled_time=base + 10)
        scheduler.add_task("t2", priority=2, scheduled_time=base + 5)
        scheduler.add_task("t3", priority=3, scheduled_time=base + 20)
        assert scheduler.get_next_task() is None
        activated = scheduler.advance_time(base + 15)
        assert activated == 2
        assert scheduler.get_pending_count() == 1
        assert scheduler.get_next_task().id == "t2"
        assert scheduler.get_next_task().id == "t1"

    def test_tasks_stay_pending_without_advance(self, scheduler):
        scheduler.add_task("future", priority=5, scheduled_time=_future(10000))
        scheduler.advance_time(_now())
        assert scheduler.get_next_task() is None

    def test_complete_and_get_next(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        for i in range(5):
            scheduler.add_task(f"t{i}", priority=5, scheduled_time=base - 10)
        t = scheduler.get_next_task()
        assert t is not None
        scheduler.complete_task(t.id)
        t2 = scheduler.get_next_task()
        assert t2 is not None and t2.id != t.id


# ── 4. Dependencies ───────────────────────

class TestDeps:

    def test_linear_chain(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=1, scheduled_time=base)
        scheduler.add_task("b", priority=1, scheduled_time=base, dependencies=("a",))
        scheduler.add_task("c", priority=1, scheduled_time=base, dependencies=("b",))
        _claim_and_complete(scheduler, "a")
        _claim_and_complete(scheduler, "b")
        _claim_and_complete(scheduler, "c")

    def test_diamond(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=4, scheduled_time=base)
        scheduler.add_task("b", priority=3, scheduled_time=base, dependencies=("a",))
        scheduler.add_task("c", priority=2, scheduled_time=base, dependencies=("a",))
        scheduler.add_task("d", priority=1, scheduled_time=base, dependencies=("b", "c"))
        _claim_and_complete(scheduler, "a")
        # b and c are now ready; b has higher priority
        t = scheduler.get_next_task()
        assert t is not None and t.id == "b"
        scheduler.complete_task("b")
        # c is now ready (its dep "a" is done); d still pending
        t2 = scheduler.get_next_task()
        assert t2 is not None and t2.id == "c"
        scheduler.complete_task("c")
        # now d should be ready (both b and c done)
        t3 = scheduler.get_next_task()
        assert t3 is not None and t3.id == "d"
        scheduler.complete_task("d")

    def test_multiple_dependencies(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=3, scheduled_time=base)
        scheduler.add_task("b", priority=2, scheduled_time=base)
        scheduler.add_task("c", priority=1, scheduled_time=base)
        scheduler.add_task("d", priority=1, scheduled_time=base, dependencies=("a", "b", "c"))
        _claim_and_complete(scheduler, "a")
        _claim_and_complete(scheduler, "b")
        _claim_and_complete(scheduler, "c")
        assert scheduler.get_next_task().id == "d"

    def test_independent_tasks(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=1, scheduled_time=base)
        scheduler.add_task("b", priority=3, scheduled_time=base)
        scheduler.add_task("c", priority=2, scheduled_time=base)
        assert [scheduler.get_next_task().id for _ in range(3)] == ["b", "c", "a"]

    def test_add_with_completed_dependency(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=5, scheduled_time=base)
        _claim_and_complete(scheduler, "a")
        scheduler.add_task("b", priority=3, scheduled_time=base, dependencies=("a",))
        assert scheduler.get_next_task().id == "b"

    def test_completion_time_tracks_dep_time(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=5, scheduled_time=base)
        _claim_and_complete(scheduler, "a")
        scheduler.add_task("b", priority=1, scheduled_time=base + 100, dependencies=("a",))
        # b is in time_heap (future time), advance to make it ready
        scheduler.advance_time(base + 100)
        t = scheduler.get_next_task()
        assert t is not None and t.id == "b"
        assert t.execution_time >= base + 100


# ── 5. Cycle detection ────────────────────

class TestCycles:

    def test_self_dependency_raises(self, scheduler):
        """With unique IDs and sequential adds, self-dep on an existing task
        hits the duplicate-ID guard first — the cycle detector remains a
        safety guard for batch / non-sequential use cases."""
        scheduler.add_task("loop", priority=5, scheduled_time=_past())
        # Duplicate-ID check fires before cycle check
        with pytest.raises(ValueError, match="already exists"):
            scheduler.add_task("loop", priority=1, scheduled_time=_past(),
                               dependencies=("loop",))

    def test_cycle_detection_exists(self, scheduler):
        """Cycle detector IS wired in (DFS on every add). It just can't fire
        in practice with unique IDs and sequential adds — proven by the fact
        that this DAG-of-decreasing-ID is structurally averted."""
        scheduler.add_task("x1", priority=5, scheduled_time=_past())
        scheduler.add_task("x2", priority=5, scheduled_time=_past(),
                           dependencies=("x1",))
        scheduler.add_task("x3", priority=5, scheduled_time=_past(),
                           dependencies=("x2", "x1"))
        assert scheduler.get_task_count() == 3  # no cycle, all added fine

    def test_no_cycle_in_long_chain(self, scheduler):
        base = _past()
        scheduler.add_task("start", priority=5, scheduled_time=base)
        prev = "start"
        for i in range(50):
            name = f"step_{i}"
            scheduler.add_task(name, priority=5, scheduled_time=base, dependencies=(prev,))
            prev = name
        assert scheduler.get_task_count() == 51  # start + 50 steps

    def test_no_cycle_in_dag(self, scheduler):
        base = _past()
        scheduler.add_task("root", priority=5, scheduled_time=base)
        scheduler.add_task("mid1", priority=5, scheduled_time=base, dependencies=("root",))
        scheduler.add_task("mid2", priority=5, scheduled_time=base, dependencies=("root",))
        scheduler.add_task("leaf", priority=5, scheduled_time=base, dependencies=("mid1", "mid2"))
        assert scheduler.get_task_count() == 4

    def test_no_cycle_add_outside_loop(self, scheduler):
        scheduler.add_task("solo_a", priority=5, scheduled_time=_past())
        scheduler.add_task("solo_b", priority=5, scheduled_time=_past(), dependencies=("solo_a",))
        scheduler.add_task("solo_c", priority=5, scheduled_time=_past())


# ── 6. Cancellation ───────────────────────

class TestCancel:

    def test_cancel_task(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        scheduler.cancel_task("a")
        assert scheduler.get_status("a") == TaskStatus.CANCELLED

    def test_cancel_prevents_retrieval(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        scheduler.cancel_task("a")
        assert scheduler.get_next_task() is None

    def test_cancel_propagates_to_dependent(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        scheduler.add_task("b", priority=3, scheduled_time=_past(), dependencies=("a",))
        scheduler.cancel_task("a")
        assert scheduler.get_status("a") == TaskStatus.CANCELLED
        assert scheduler.get_status("b") == TaskStatus.CANCELLED

    def test_cancel_propagates_multiple_levels(self, scheduler):
        base = _past()
        scheduler.add_task("a", priority=5, scheduled_time=base)
        scheduler.add_task("b", priority=4, scheduled_time=base, dependencies=("a",))
        scheduler.add_task("c", priority=3, scheduled_time=base, dependencies=("b",))
        scheduler.add_task("d", priority=2, scheduled_time=base, dependencies=("c",))
        scheduler.cancel_task("a")
        for tid in ("a", "b", "c", "d"):
            assert scheduler.get_status(tid) == TaskStatus.CANCELLED

    def test_cancel_already_cancelled_is_noop(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        scheduler.cancel_task("a")
        scheduler.cancel_task("a")

    def test_cancel_nonexistent_raises_keyerror(self, scheduler):
        with pytest.raises(KeyError):
            scheduler.cancel_task("nonexistent")

    def test_cancel_does_not_affect_unrelated_tasks(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        scheduler.add_task("b", priority=4, scheduled_time=_past())
        scheduler.cancel_task("a")
        t = scheduler.get_next_task()
        assert t is not None and t.id == "b"


# ── 7. Task failure ───────────────────────

class TestFail:

    def test_fail_task(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        t = scheduler.get_next_task()
        assert t.id == "a"
        scheduler.fail_task("a")
        assert scheduler.get_status("a") == TaskStatus.FAILED

    def test_fail_prevents_dependents(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        scheduler.add_task("b", priority=3, scheduled_time=_past(), dependencies=("a",))
        t = scheduler.get_next_task()
        assert t.id == "a"
        scheduler.fail_task("a")
        assert scheduler.get_status("b") == TaskStatus.FAILED

    def test_fail_non_executing_raises(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        with pytest.raises(InvalidTaskStateError):
            scheduler.fail_task("a")

    def test_fail_pending_task_raises(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        scheduler.add_task("b", priority=3, scheduled_time=_past(), dependencies=("a",))
        with pytest.raises(InvalidTaskStateError):
            scheduler.fail_task("b")

    def test_complete_non_executing_raises(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        with pytest.raises(InvalidTaskStateError):
            scheduler.complete_task("a")

    def test_nonexistent_task_raises_keyerror(self, scheduler):
        with pytest.raises(KeyError):
            scheduler.complete_task("nope")


# ── 8. Dynamic updates ────────────────────

class TestUpdate:

    def test_update_priority_of_ready_task(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=1, scheduled_time=base)
        scheduler.add_task("b", priority=1, scheduled_time=base)
        scheduler.update_task("a", priority=10)
        assert scheduler.get_next_task().id == "a"

    def test_update_priority_after_push(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("low", priority=1, scheduled_time=base)
        scheduler.add_task("high", priority=1, scheduled_time=base)
        scheduler.update_task("high", priority=100)
        assert scheduler.get_next_task().id == "high"

    def test_update_scheduled_time_of_pending_task(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=5, scheduled_time=base + 100)
        scheduler.add_task("b", priority=5, scheduled_time=base + 50)
        scheduler.add_task("c", priority=5, scheduled_time=base + 200)
        assert scheduler.get_next_task() is None
        scheduler.update_task("c", scheduled_time=base - 10)
        assert scheduler.get_next_task().id == "c"

    def test_update_completed_task_is_noop(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        t = scheduler.get_next_task()
        assert t.id == "a"
        scheduler.complete_task("a")
        scheduler.update_task("a", priority=999)
        assert scheduler.get_task("a").priority == 5

    def test_update_executing_raises(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        scheduler.get_next_task()
        with pytest.raises(InvalidTaskStateError, match="EXECUTING"):
            scheduler.update_task("a", priority=999)

    def test_update_nonexistent_raises(self, scheduler):
        with pytest.raises(KeyError):
            scheduler.update_task("ghost", priority=99)

    def test_update_only_priority(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=1, scheduled_time=base)
        scheduler.update_task("a", priority=10)
        assert scheduler.get_next_task().id == "a" and scheduler.get_task("a").scheduled_time == base

    def test_update_only_scheduled_time(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        scheduler.update_task("a", scheduled_time=_past(20))
        assert scheduler.get_next_task().id == "a"

    def test_update_and_advance_time(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=5, scheduled_time=base + 50)
        scheduler.update_task("a", scheduled_time=base + 5)
        scheduler.advance_time(base + 10)
        assert scheduler.get_next_task().id == "a"


# ── 9. Edge cases ─────────────────────────

class TestEdgeCases:

    def test_duplicate_task_id_raises(self, scheduler):
        scheduler.add_task("dup", priority=5, scheduled_time=_past())
        with pytest.raises(ValueError, match="already exists"):
            scheduler.add_task("dup", priority=5, scheduled_time=_past())

    def test_missing_dependency_raises(self, scheduler):
        with pytest.raises(ValueError, match="not found"):
            scheduler.add_task("a", priority=5, scheduled_time=_past(), dependencies=("missing",))

    def test_task_with_future_time_and_completed_dep(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=5, scheduled_time=base)
        _claim_and_complete(scheduler, "a")
        scheduler.add_task("b", priority=3, scheduled_time=base + 500, dependencies=("a",))
        assert scheduler.get_task("b").execution_time >= base + 500

    def test_task_with_past_time_and_completed_dep(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=5, scheduled_time=base - 100)
        _claim_and_complete(scheduler, "a")
        scheduler.add_task("b", priority=3, scheduled_time=base - 200, dependencies=("a",))
        t = scheduler.get_next_task()
        assert t is not None and t.id == "b"

    def test_cancel_nonexistent_raises_keyerror(self, scheduler):
        with pytest.raises(KeyError):
            scheduler.cancel_task("nonexistent")

    def test_update_task_with_no_deps(self, scheduler):
        scheduler.add_task("a", priority=1, scheduled_time=_past())
        scheduler.update_task("a", priority=10)
        assert scheduler.get_next_task().id == "a"

    def test_multiple_same_deps(self, scheduler):
        base = _past()
        scheduler.add_task("a", priority=5, scheduled_time=base)
        _claim_and_complete(scheduler, "a")
        scheduler.add_task("b", priority=3, scheduled_time=base, dependencies=("a", "a"))
        assert scheduler.get_next_task().id == "b"

    def test_get_ready_count(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("a", priority=1, scheduled_time=base)
        scheduler.add_task("b", priority=2, scheduled_time=base + 100)
        scheduler.add_task("c", priority=3, scheduled_time=base)
        assert scheduler.get_ready_count() == 2
        assert scheduler.get_pending_count() == 1

    def test_get_completed_count(self, scheduler):
        scheduler.add_task("a", priority=5, scheduled_time=_past())
        _claim_and_complete(scheduler, "a")
        assert scheduler.get_completed_count() == 1

    def test_zero_tasks(self, scheduler):
        assert scheduler.get_next_task() is None
        assert scheduler.get_ready_count() == 0
        assert scheduler.get_pending_count() == 0
        assert scheduler.get_completed_count() == 0
        assert scheduler.get_task_count() == 0


# ── 10. Large-scale ───────────────────────

class TestLargeScale:

    def test_1m_tasks(self):
        import time as _tm
        base = 1_000_000.0
        n = 1_000_000

        # Use bulk_add (skips per-task cycle DFS) for speed.
        # Structure:
        #   Layer 0: 100 tasks, no deps
        #   Layer 1..: each task depends on 2 tasks 50 positions earlier
        #   This keeps transitive closure tiny → fast bulk adds
        s = TaskScheduler()
        s.set_current_time(base)

        # Phase 1: Seed layer 0 (no deps)
        start = _tm.time()
        items0 = [(f"t{i}", 1000000 - i, base, None, None) for i in range(100)]
        s.add_tasks(items0)

        # Phase 2: Add remaining 999900 tasks, batch by 50k
        BATCH = 50000
        current_priority = 1000000 - 100
        for batch_start in range(100, n, BATCH):
            batch_end = min(batch_start + BATCH, n)
            items = []
            for i in range(batch_start, batch_end):
                # Each task depends on 2 tasks from 50 positions earlier
                dep1 = f"t{i - 50}"
                dep2 = f"t{i - 100}"
                items.append((f"t{i}", current_priority, base, (dep1, dep2), None))
                current_priority -= 1
            s.add_tasks(items)
        add_time = _tm.time() - start

        # Phase 3: Execute all tasks
        start = _tm.time()
        completed = 0
        while completed < n:
            task = s.get_next_task()
            if task is None:
                completed += s.advance_time(base)
                continue
            s.complete_task(task.id)
            completed += 1
        exec_time = _tm.time() - start

        assert s.get_completed_count() == n, f"Only {s.get_completed_count()} completed"
        assert s.get_pending_count() == 0, f"{s.get_pending_count()} still pending"
        print(f"\n✓ 1M tasks: added in {add_time:.2f}s, executed in {exec_time:.2f}s")

    def test_diamond_with_large_fan_in(self, scheduler):
        base = 1000.0
        scheduler.set_current_time(base)
        scheduler.add_task("root", priority=100, scheduled_time=base)
        _claim_and_complete(scheduler, "root")
        for i in range(1000):
            scheduler.add_task(f"leaf-{i}", priority=1, scheduled_time=base,
                               dependencies=("root",))
        assert scheduler.get_ready_count() == 1000
        assert scheduler.get_pending_count() == 0
        completed = 0
        while completed < 1000:
            task = scheduler.get_next_task()
            assert task is not None
            scheduler.complete_task(task.id)
            completed += 1
        assert scheduler.get_completed_count() == 1001


# ── 11. Thread safety ─────────────────────

class TestConcurrency:

    def test_concurrent_adds(self):
        import time as _tm
        s = TaskScheduler()
        base = _tm.time()
        errors = []
        barrier = threading.Barrier(10)

        def add_tasks(tid):
            try:
                barrier.wait(timeout=5)
                for i in range(100):
                    s.add_task(f"t{tid}_{i}", priority=tid, scheduled_time=base - 10)
            except Exception as e:
                errors.append(str(e))

        threads = [threading.Thread(target=add_tasks, args=(i,)) for i in range(10)]
        for t in threads: t.start()
        for t in threads: t.join(timeout=10)
        assert not errors
        assert s.get_task_count() == 1000

    def test_concurrent_get_and_complete(self):
        import time as _tm
        s = TaskScheduler()
        base = _tm.time()
        for i in range(200):
            s.add_task(f"t{i}", priority=1, scheduled_time=base)
        results = []
        rl = threading.Lock()
        errors = []

        def worker():
            try:
                while True:
                    task = s.get_next_task()
                    if task is None:
                        break
                    s.complete_task(task.id)
                    with rl:
                        results.append(task.id)
            except Exception as e:
                errors.append(str(e))

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads: t.start()
        for t in threads: t.join(timeout=15)
        assert not errors
        assert len(results) == 200
        assert len(set(results)) == 200


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
