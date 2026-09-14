from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from task_scheduler import (
    DependencyCycleError,
    InvalidTaskStateError,
    Task,
    TaskRecord,
    TaskScheduler,
    TaskUpdate,
    TaskUpdateError,
    UnknownTaskError,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def time(self) -> float:
        return self.now

    def wait_for(self, seconds: float) -> None:
        assert seconds >= 0
        self.now += seconds


def make_scheduler(clock: FakeClock | None = None, *, allow_cycles: bool = False) -> TaskScheduler[str]:
    return TaskScheduler[str](clock=clock or FakeClock(), allow_cycles=allow_cycles)


def test_ready_timestamp_and_dependency_gate_control_executability() -> None:
    clock = FakeClock()
    scheduler = make_scheduler(clock)
    scheduler.register_task(Task("low", priority=1, ready_at=0.0, dependencies=[]))
    scheduler.register_task(
        Task("high", priority=10, ready_at=10.0, dependencies=["low"])
    )

    assert scheduler.next_task() is None
    clock.advance(9)
    assert scheduler.next_task() is None
    clock.advance(1)
    assert scheduler.next_task().task_id == "high"


def test_priority_breaks_timestamp_ties_only_after_tasks_are_ready() -> None:
    scheduler = make_scheduler()
    scheduler.register_task(Task("future-low", priority=1, ready_at=10.0, dependencies=[]))
    scheduler.register_task(Task("now-low", priority=1, ready_at=0.0, dependencies=[]))
    scheduler.register_task(Task("now-high", priority=10, ready_at=0.0, dependencies=[]))

    assert [scheduler.next_task().task_id for _ in range(2)] == ["now-high", "now-low"]
    assert scheduler.next_task().task_id == "future-low"


def test_peek_does_not_claim_and_completion_makes_dependency_progress() -> None:
    scheduler = make_scheduler()
    scheduler.register_task(Task("parent", priority=5, ready_at=0, dependencies=["child"]))
    scheduler.register_task(Task("child", priority=5, ready_at=0, dependencies=[]))

    assert isinstance(scheduler.peek_next(), TaskRecord)
    assert scheduler.peek_next().task_id == "child"
    assert scheduler.next_task().task_id == "child"
    assert scheduler.complete("child", result="ok").task_id == "child"
    assert scheduler.next_task().task_id == "parent"


def test_dynamic_ready_timestamp_moves_a_ready_task_into_the_future() -> None:
    clock = FakeClock()
    scheduler = make_scheduler(clock)
    scheduler.register_task(Task("first", priority=1, ready_at=0, dependencies=[]))
    scheduler.register_task(
        Task("second", priority=10, ready_at=0, dependencies=[])
    )

    assert scheduler.next_task().task_id == "second"
    scheduler.complete("second")
    assert scheduler.update_task(
        "first", ready_at=10, priority=1
    ) == scheduler.get_task_record("first")
    assert scheduler.peek_next() is None
    clock.advance(10)
    assert scheduler.next_task().task_id == "first"


def test_dependency_update_unblocks_a_task() -> None:
    scheduler = make_scheduler()
    scheduler.register_task(Task("child", priority=1, ready_at=0, dependencies=[]))
    scheduler.register_task(Task("parent", priority=10, ready_at=0, dependencies=["child"]))
    assert scheduler.next_task().task_id == "child"
    scheduler.complete("child")

    assert scheduler.update_task("parent", dependencies=[]).state.name == "READY"
    assert scheduler.next_task().task_id == "parent"


def test_strict_scheduler_rejects_a_dependency_cycle_atomically() -> None:
    scheduler = make_scheduler()
    scheduler.register_task(Task("a", priority=1, ready_at=0, dependencies=["b"]))
    scheduler.register_task(Task("b", priority=1, ready_at=0, dependencies=["c"]))
    original = scheduler.get_task_record("c").dependencies

    with pytest.raises(DependencyCycleError):
        scheduler.replace_dependencies_batch({"c": ["a"]})

    assert scheduler.get_task_record("c").dependencies == original
    assert scheduler.peek_next() is None


def test_cycle_diagnostics_are_available_in_diagnostics_mode() -> None:
    scheduler = make_scheduler(allow_cycles=True)
    scheduler.register_task(Task("a", priority=1, ready_at=0, dependencies=["b"]))
    scheduler.register_task(Task("b", priority=1, ready_at=0, dependencies=["a"]))

    assert scheduler.has_cycle()
    cycle = scheduler.find_cycle("a")
    assert cycle is not None
    assert len(cycle) >= 2
    assert cycle[0] == cycle[-1]
    assert scheduler.next_task() is None


def test_dynamic_batch_update_is_atomic() -> None:
    scheduler = make_scheduler()
    scheduler.register_task(Task("a", priority=1, ready_at=0, dependencies=[]))
    scheduler.register_task(Task("b", priority=1, ready_at=0, dependencies=[]))
    assert scheduler.next_task().task_id == "a"
    scheduler.complete("a")

    with pytest.raises(InvalidTaskStateError):
        scheduler.update_tasks(
            {
                "a": TaskUpdate(priority=99),
                "b": TaskUpdate(priority=10),
            }
        )

    assert scheduler.get_task_record("b").priority == 1


def test_unknown_dependency_is_rejected() -> None:
    scheduler = make_scheduler()
    with pytest.raises(UnknownTaskError):
        scheduler.register_task(
            Task("task", priority=1, ready_at=0, dependencies=["missing"])
        )


def test_duplicate_task_ids_are_rejected_without_partial_insertion() -> None:
    scheduler = make_scheduler()
    with pytest.raises(TaskUpdateError):
        scheduler.register_tasks(
            [
                Task("a", priority=1, ready_at=0, dependencies=[]),
                Task("a", priority=1, ready_at=0, dependencies=[]),
            ]
        )
    assert scheduler.task_count == 0


def test_retry_makes_a_failed_task_reschedulable() -> None:
    scheduler = make_scheduler()
    scheduler.register_task(Task("task", priority=1, ready_at=0, dependencies=[]))
    assert scheduler.next_task().task_id == "task"
    scheduler.fail("task", "temporary failure")
    assert scheduler.get_task_record("task").state.name == "FAILED"

    assert scheduler.retry("task", ready_at=5).state.name == "SCHEDULED"
    assert scheduler.peek_next() is None
    scheduler.clock.now = 5
    assert scheduler.next_task().task_id == "task"


def test_wait_for_next_blocks_until_a_due_task_is_claimable() -> None:
    clock = FakeClock()
    scheduler = make_scheduler(clock)
    scheduler.register_task(Task("task", priority=1, ready_at=5, dependencies=[]))

    assert not scheduler.wait_for_next(timeout=1)
    assert clock.now == 1
    clock.advance(4)
    assert scheduler.wait_for_next(timeout=0)
    assert scheduler.next_task().task_id == "task"


def test_bulk_registration_of_many_tasks() -> None:
    clock = FakeClock()
    scheduler = make_scheduler(clock)
    tasks = [
        Task(str(index), priority=index % 3, ready_at=0, dependencies=[])
        for index in range(10_000)
    ]
    records = scheduler.register_tasks(tasks)

    assert records is None
    assert scheduler.task_count == 10_000


def test_concurrent_claims_never_duplicate_a_task() -> None:
    scheduler = make_scheduler()
    for index in range(200):
        scheduler.register_task(
            Task(str(index), priority=0, ready_at=0, dependencies=[])
        )

    barrier = threading.Barrier(16)
    completed: set[str] = set()
    claims: set[str] = set()

    def worker() -> None:
        barrier.wait()
        while lease := scheduler.next_task():
            claims.add(lease.task_id)
            scheduler.complete(lease.task_id)
            completed.add(lease.task_id)

    with ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(lambda _: worker(), range(16)))

    assert claims == completed
    assert claims == {str(index) for index in range(200)}
    assert scheduler.peek_next() is None
