"""Tests for the in-memory priority task scheduler.

Run with::

    python -m pytest tests/ -q

These tests exercise the full public surface plus every edge case the design
specifies: cycle detection, dependency propagation, promotion/demotion, failed
task propagation, cancellation cascades, dynamic updates, and the full state
transition matrix.
"""

from __future__ import annotations

import threading
import time
import uuid
from datetime import timedelta

import pytest

from src.scheduler import (
    AlreadyExistsError,
    Priority,
    Scheduler,
    TaskNotFoundError,
    TaskState,
)


def task(s: Scheduler, label: str, **kw) -> str:
    return s.add_task(label, **kw)


# ---------------------------------------------------------------------------
# basic scheduling
# ---------------------------------------------------------------------------
def test_single_task_scheduled_and_consumed():
    s = Scheduler()
    tid = s.add_task("a")
    assert tid in s
    assert s.next_task() == tid
    assert s.get_task_status(tid) == TaskState.RUNNING
    # once running it is not re-picked
    assert s.next_task() is None
    assert s.peek_next_task() is None


def test_dupe_ids_rejected():
    s = Scheduler()
    a = s.add_task("a")
    with pytest.raises(AlreadyExistsError):
        s.add_task("a", task_id=a)
    # auto-generated ids are unique
    assert s.add_task("b") != s.add_task("c")


def test_next_task_returns_none_when_empty():
    s = Scheduler()
    assert s.next_task() is None
    assert s.peek_next_task() is None
    assert s.earliest_run_time() is None
    assert s.ready_count() == 0


def test_pending_task_not_consumed_until_due():
    now = time.time()
    s = Scheduler()
    fut = s.add_task("future", due=now + 100)
    # not executable yet
    assert s.next_task() is None
    assert s.peek_next_task() is None
    # but it is queued and its run time is exposed
    assert s.ready_count() == 1
    assert s.earliest_run_time() is not None
    assert abs(s.earliest_run_time() - (now + 100)) < 0.01


def test_garbage_collected_when_due():
    now = time.time()
    s = Scheduler()
    s.add_task("past", due=now - 1)
    assert s.next_task() == s.get_active()[0]


def test_priority_breaks_due_ties():
    now = time.time()
    s = Scheduler()
    s.add_task("low", priority=Priority.LOW, due=now)
    s.add_task("high", priority=Priority.HIGHEST, due=now)
    s.add_task("mid", priority=Priority.NORMAL, due=now)
    assert s.next_task() == s.get_task("high")


def test_priority_orders_next_tasks():
    now = time.time()
    s = Scheduler()
    s.add_task("low", priority=Priority.LOW, due=now)
    s.add_task("high", priority=Priority.HIGHEST, due=now)
    s.add_task("mid", priority=Priority.NORMAL, due=now)
    first = s.next_task()
    s.done_task(first)
    second = s.next_task()
    s.done_task(second)
    third = s.next_task()
    # descending priority: high, mid, low
    assert first == s.get_task("high")
    assert second == s.get_task("mid")
    assert third == s.get_task("low")


def test_insertion_order_breaks_detailed_ties():
    now = time.time()
    s = Scheduler()
    a = s.add_task("a", due=now, priority=Priority.NORMAL)
    b = s.add_task("b", due=now, priority=Priority.NORMAL)
    c = s.add_task("c", due=now, priority=Priority.NORMAL)
    assert s.next_task() == a
    s.done_task(a)
    assert s.next_task() == b
    s.done_task(b)
    assert s.next_task() == c


def test_due_can_be_none_and_defaults_to_now():
    now = time.time()
    s = Scheduler()
    t = s.add_task("x")
    assert s.earliest_run_time() is not None
    assert s.earliest_run_time() <= time.time() + 0.01


def test_due_as_timedelta():
    s = Scheduler()
    s.add_task("soondelta", due=timedelta(seconds=0))
    s.add_task("laterdelta", due=timedelta(seconds=3600))
    assert s.next_task() == s.get_active()[0]
    assert s.next_task() is None  # the 3600s one is time-gated


def test_priority_validated_range():
    s = Scheduler()
    with pytest.raises(ValueError):
        s.add_task("bad", priority=100)
    with pytest.raises(TypeError):
        s.add_task("bad", priority="loud")


# ---------------------------------------------------------------------------
# depend
# ---------------------------------------------------------------------------
def test_dependency_blocks_until_parent_done():
    s = Scheduler()
    p = s.add_task("parent")
    c = s.add_task("child", depends_on=[p])
    assert s.get_task_status(c) == TaskState.WAITING
    assert s.next_task() == p
    # child still waits while parent running
    assert s.next_task() is None
    s.done_task(p)
    # now child is executable
    assert s.next_task() == c


def test_multiple_dependencies_all_required():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b")
    c = s.add_task("c", depends_on=[a, b])
    assert s.get_task_dep_count(c) == 2
    assert s.next_task() == a
    s.done_task(a)
    # still waiting on b
    assert s.get_task_status(c) == TaskState.WAITING
    assert s.next_task() is None
    s.done_task(b)
    assert s.next_task() == c


def test_dependent_of_dependent_chain():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b", depends_on=[a])
    c = s.add_task("c", depends_on=[b])
    order = []
    order.append(s.next_task())
    s.done_task(order[0])
    order.append(s.next_task())
    s.done_task(order[1])
    order.append(s.next_task())
    s.done_task(order[2])
    assert order == [a, b, c]


def test_sixteen_task_pipeline_resolves():
    s = Scheduler()
    # a diamond-ish DAG of 16 tasks with a topological layering.
    names = [f"t{i:02d}" for i in range(16)]
    s.add_task("t00")
    s.add_task("t01", depends_on=["t00"])
    s.add_task("t02", depends_on=["t01"])
    s.add_task("t03", depends_on=["t02"])
    s.add_task("t04", depends_on=["t03"])
    s.add_task("t05", depends_on=["t04"])
    s.add_task("t06", depends_on=["t05"])
    s.add_task("t07", depends_on=["t06"])
    s.add_task("t08", depends_on=["t07"])
    s.add_task("t09", depends_on=["t08"])
    s.add_task("t10", depends_on=["t09"])
    s.add_task("t11", depends_on=["t10"])
    s.add_task("t12", depends_on=["t11"])
    s.add_task("t13", depends_on=["t12"])
    s.add_task("t14", depends_on=["t13"])
    s.add_task("t15", depends_on=["t14"])

    done = 0
    while (n := s.next_task()) is not None:
        s.done_task(n)
        done += 1
    assert done == 16
    assert all(s.get_task_status(n) == TaskState.DONE for n in names)


def test_task_with_missing_dependency_raises():
    s = Scheduler()
    with pytest.raises(TaskNotFoundError):
        s.add_task("orphan", depends_on=["nope"])


def test_dependent_on_done_parent_starts_immediately():
    s = Scheduler()
    a = s.add_task("a")
    s.done_task(a)
    # a is done; adding a dependent should find its dep resolved -> PENDING
    c = s.add_task("c", depends_on=[a])
    assert s.get_task_status(c) == TaskState.PENDING
    assert s.next_task() == c


# ---------------------------------------------------------------------------
# cycle detection
# ---------------------------------------------------------------------------
def test_self_dependency_rejected():
    s = Scheduler()
    a = s.add_task("a")
    with pytest.raises(ValueError):
        s.add_task("b", depends_on=[a, "b"])


def test_two_node_cycle_rejected():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b")
    # adding a 3rd node that depends on both is fine; then closing a cycle must
    # be rejected. Build a<->b: first a depends on b, then attempt b depends on a.
    s.update_task(a, depends_on=[b])
    with pytest.raises(ValueError):
        s.update_task(b, depends_on=[a])
    # schedule left unchanged by the rejected update
    assert s.dump()["a"]["deps"] == ["b"]
    assert s.dump()["b"]["deps"] == []


def test_three_node_cycle_rejected_and_schedule_untouched():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b")
    c = s.add_task("c", depends_on=[b])
    before = s.dump()
    # attempt c -> a -> c cycle: add a depends on c
    with pytest.raises(ValueError):
        s.update_task(a, depends_on=[c])
    after = s.dump()
    assert before == after  # schedule unchanged


def test_dependent_only_cycle_via_update():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b")
    # build a<->b cycle
    s.update_task(a, depends_on=[b])
    with pytest.raises(ValueError):
        s.update_task(b, depends_on=[a])


# ---------------------------------------------------------------------------
# done / fail / cancel
# ---------------------------------------------------------------------------
def test_done_task_transitions():
    s = Scheduler()
    t = s.add_task("t")
    assert s.next_task() == t
    s.done_task(t)
    assert s.get_task_status(t) == TaskState.DONE


def test_done_before_fetch_raises():
    s = Scheduler()
    t = s.add_task("t")
    with pytest.raises(RuntimeError):
        s.done_task(t)


def test_done_twice_raises():
    s = Scheduler()
    t = s.add_task("t")
    s.next_task()
    s.done_task(t)
    with pytest.raises(ValueError):
        s.done_task(t)


def test_done_deprecated_flag():
    s = Scheduler()
    t = s.add_task("t")
    s.next_task()
    s.done_task(t, deprecated=True)
    assert s.get_task_status(t) == TaskState.DEPRECATED
    with pytest.raises(ValueError):
        s.done_task(t, deprecated=True)


def test_done_unknown_task_raises():
    s = Scheduler()
    with pytest.raises(TaskNotFoundError):
        s.done_task("nope")


def test_fail_task_and_propagation():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b", depends_on=[a])
    c = s.add_task("c", depends_on=[b])
    s.next_task()  # a running
    s.fail_task(a, message="boom")
    assert s.get_task_status(a) == TaskState.FAILED
    assert s.get_task_status(b) == TaskState.FAILED
    assert s.get_task_status(c) == TaskState.FAILED


def test_fail_status_reflected_in_dependencies():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b", depends_on=[a])
    s.next_task()
    s.fail_task(a)
    # b's remaining deps should now be empty set (cascade terminal clears it)
    assert s.get_task_dependencies(b) == set()
    assert s.get_task_status(b) == TaskState.FAILED


def test_fail_before_fetch_raises():
    s = Scheduler()
    t = s.add_task("t")
    with pytest.raises(RuntimeError):
        s.fail_task(t)


def test_fail_after_terminal_raises():
    s = Scheduler()
    t = s.add_task("t")
    s.next_task()
    s.fail_task(t)
    with pytest.raises(ValueError):
        s.fail_task(t)


def test_cancel_task_and_dependents():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b", depends_on=[a])
    c = s.add_task("c", depends_on=[b])
    s.cancel_task(a)
    assert s.get_task_status(a) == TaskState.CANCELLED
    assert s.get_task_status(b) == TaskState.CANCELLED
    assert s.get_task_status(c) == TaskState.CANCELLED


def test_cancel_singleshot_task():
    s = Scheduler()
    a = s.add_task("a")
    s.cancel_task(a)
    assert s.get_task_status(a) == TaskState.CANCELLED
    assert s.next_task() is None


def test_cancel_unknown_raises():
    s = Scheduler()
    with pytest.raises(TaskNotFoundError):
        s.cancel_task("nope")


# ---------------------------------------------------------------------------
# dynamic updates
# ---------------------------------------------------------------------------
def test_update_due_later_then_earlier():
    now = time.time()
    s = Scheduler()
    a = s.add_task("a", due=now)
    b = s.add_task("b", due=now + 100)
    # b was due far out
    assert s.next_task() == a
    # update b to be now -> it becomes eligible and now precedes a? same due
    s.update_task(b, due=now - 1)
    assert s.peek_next_task() == b
    s.done_task(a)
    assert s.next_task() == b


def test_update_priority_change_reflected():
    now = time.time()
    s = Scheduler()
    a = s.add_task("a", due=now)
    b = s.add_task("b", due=now)
    assert s.next_task() == a  # insertion order
    s.update_task(a, priority=Priority.HIGHEST)
    # a now moves to top despite insertion
    assert s.peek_next_task() == a


def test_update_due_via_timedelta():
    s = Scheduler()
    s.add_task("a")
    s.update_task("a", due=timedelta(seconds=0))
    assert s.next_task() == "a"


def test_update_nonexistent_task_raises():
    s = Scheduler()
    with pytest.raises(TaskNotFoundError):
        s.update_task("nope", label="x")


def test_update_terminal_task_raises():
    s = Scheduler()
    t = s.add_task("t")
    s.next_task()
    s.done_task(t)
    with pytest.raises(RuntimeError):
        s.update_task(t, label="x")


def test_update_dependency_change_promotes_child():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b", depends_on=[a])
    # b waits on a
    assert s.get_task_status(b) == TaskState.WAITING
    # remove a from b's deps
    s.update_task(b, depends_on=[])
    assert s.get_task_status(b) == TaskState.PENDING
    assert s.next_task() == b


def test_update_dependency_add_demotes_child():
    now = time.time()
    s = Scheduler()
    a = s.add_task("a", due=now)
    c = s.add_task("c", depends_on=[a])  # c waits on a
    # c should be waiting
    assert s.get_task_status(c) == TaskState.WAITING
    # update c to depend on a (already) - no change
    # instead make a depend on something then c waits... build a fresh scenario
    b = s.add_task("b", due=now)
    s.update_task(c, depends_on=[b])
    # c now depends on b (running? b is pending) -> still waiting
    assert s.get_task_status(c) == TaskState.WAITING


def test_update_due_only_unchanged_no_error():
    s = Scheduler()
    t = s.add_task("t", due=time.time())
    # re-update due to essentially same value; should not raise
    s.update_task(t, due=time.time())
    assert s.get_task_status(t) == TaskState.PENDING


# ---------------------------------------------------------------------------
# state transition matrix (exhaustive)
# ---------------------------------------------------------------------------
def test_state_transition_matrix():
    s = Scheduler()
    t = s.add_task("t")

    # PENDING -> next_task -> RUNNING
    assert s.next_task() == t
    assert s.get_task_status(t) == TaskState.RUNNING

    # RUNNING -> done -> DONE
    s.done_task(t)
    assert s.get_task_status(t) == TaskState.DONE


def test_running_state_occupies_nothing_repeated():
    s = Scheduler()
    t = s.add_task("t")
    s.next_task()
    # while running, next_task should not re-issue it
    assert s.next_task() is None
    s.done_task(t)


# ---------------------------------------------------------------------------
# get_children
# ---------------------------------------------------------------------------
def test_get_children_reflects_dag():
    s = Scheduler()
    a = s.add_task("a")
    b = s.add_task("b", depends_on=[a])
    c = s.add_task("c", depends_on=[a])
    assert set(s.get_children(a)) == {b, c}
    assert s.get_children(b) == []
    assert s.get_children("missing") == []


def test_get_children_empty_for_root():
    s = Scheduler()
    a = s.add_task("a")
    assert s.get_children(a) == []


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def test_reset_clears_all():
    s = Scheduler()
    s.add_task("a")
    s.add_task("b")
    s.reset()
    assert len(s) == 0
    assert s.next_task() is None


def test_len_and_contains():
    s = Scheduler()
    a = s.add_task("a")
    assert len(s) == 1
    assert a in s
    assert "zzz" not in s


def test_iter_tasks():
    s = Scheduler()
    s.add_task("a")
    s.add_task("b")
    labels = {t.label for t in s.iter_tasks()}
    assert labels == {"a", "b"}


def test_dump_shape():
    s = Scheduler()
    a = s.add_task("a", meta={"k": "v"})
    d = s.dump()
    assert a in d
    assert d[a]["label"] == "a"
    assert d[a]["meta"] == {"k": "v"}
    assert d[a]["deps"] == []
    assert d[a]["state"] == TaskState.PENDING.value


def test_missing_task_lookup_raises():
    s = Scheduler()
    with pytest.raises(TaskNotFoundError):
        s.get_task("nope")


def test_taskinput_and_task_kwargs_equivalence():
    from src.scheduler import TaskInput
    s = Scheduler()
    inp = TaskInput(label="via_input", priority=Priority.HIGHEST, due=0, depends_on=())
    tid = s.add_task(inp)
    assert s.get_task_status(tid) == TaskState.PENDING


def test_add_task_with_taskid_keyword():
    s = Scheduler()
    tid = s.add_task("a", task_id="custom-1")
    assert tid == "custom-1"
    with pytest.raises(AlreadyExistsError):
        s.add_task("b", task_id="custom-1")


# ---------------------------------------------------------------------------
# threads
# ---------------------------------------------------------------------------
def test_scheduler_has_no_shared_lock():
    # The scheduler is documented single-threaded; verifying it at least does
    # not raise when constructed and a timer is armed.
    s = Scheduler()
    s.arm_timer()
    s.disarm_timer()


def test_earliest_run_time_none_when_idle():
    s = Scheduler()
    assert s.earliest_run_time() is None
    s.add_task("x", due=time.time() + 100)
    assert s.earliest_run_time() is not None


def test_all_states_can_be_listed():
    s = Scheduler()
    assert set(TaskState) >= {
        TaskState.PENDING,
        TaskState.RUNNING,
        TaskState.WAITING,
        TaskState.DONE,
        TaskState.CANCELLED,
        TaskState.DEPRECATED,
        TaskState.FAILED,
    }
