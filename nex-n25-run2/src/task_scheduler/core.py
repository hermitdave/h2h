"""Thread-safe, dependency-aware in-memory task scheduler.

The scheduler owns scheduling state only. A caller obtains an immutable lease
from :meth:`TaskScheduler.next_task` and reports its outcome with
:meth:`TaskScheduler.complete` or :meth:`TaskScheduler.fail`. The lease token
prevents a stale worker from resolving a task that has already been retried.

The deterministic ordering rule is:

1. earliest ready timestamp;
2. largest numeric priority;
3. earlier registration or update sequence number.
"""

from __future__ import annotations

import heapq
import math
import threading
import time
import uuid
from collections.abc import Callable, Hashable, Iterable, Mapping
from dataclasses import dataclass, replace
from enum import Enum
from typing import Generic, TypeVar

TaskId = TypeVar("TaskId", bound=Hashable)


class TaskUpdateError(Exception):
    """Base error for invalid scheduler mutations."""


class UnknownTaskError(TaskUpdateError):
    """Raised when a task or dependency ID is unknown."""


class InvalidTaskStateError(TaskUpdateError):
    """Raised when a lifecycle operation is invalid for a task."""


class DependencyCycleError(TaskUpdateError):
    """Raised when a strict scheduler is asked to create a cycle."""


class TaskState(Enum):
    """Lifecycle states for a submitted task."""

    SCHEDULED = "SCHEDULED"
    READY = "READY"
    CLAIMED = "CLAIMED"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"


@dataclass(frozen=True, slots=True)
class Task(Generic[TaskId]):
    """An immutable task submission.

    ``ready_at`` is the earliest time at which the task may be claimed.
    Dependencies must already exist for ``register_task`` and may refer to tasks
    in the same batch for ``register_tasks``.
    """

    task_id: TaskId
    priority: int
    ready_at: float = 0.0
    dependencies: Iterable[TaskId] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "priority", _coerce_priority(self.priority))
        object.__setattr__(self, "ready_at", _coerce_timestamp(self.ready_at))
        object.__setattr__(
            self, "dependencies", _normalise_dependencies(self.dependencies)
        )
        if any(dependency == self.task_id for dependency in self.dependencies):
            raise TaskUpdateError(
                f"task {self.task_id!r} cannot depend on itself"
            )


@dataclass(frozen=True, slots=True)
class TaskUpdate:
    """A partial atomic task update.

    ``None`` means that the field is unchanged. Dependencies are replaced, not
    merged.
    """

    priority: int | None = None
    ready_at: float | None = None
    dependencies: Iterable[TaskId] | None = None

    def __post_init__(self) -> None:
        if self.priority is not None:
            object.__setattr__(self, "priority", _coerce_priority(self.priority))
        if self.ready_at is not None:
            object.__setattr__(self, "ready_at", _coerce_timestamp(self.ready_at))
        if self.dependencies is not None:
            object.__setattr__(
                self, "dependencies", _normalise_dependencies(self.dependencies)
            )


@dataclass(frozen=True, slots=True)
class TaskRecord(Generic[TaskId]):
    """Immutable public snapshot of one task."""

    task_id: TaskId
    priority: int
    execution_timestamp: float
    dependencies: tuple[TaskId, ...]
    state: TaskState
    revision: int
    pending_dependencies: int
    claim_token: str | None = None

    @property
    def ready_at(self) -> float:
        """Alias for the earliest execution timestamp."""

        return self.execution_timestamp

    @property
    def claim_id(self) -> str | None:
        """Alias emphasising that the token identifies a lease."""

        return self.claim_token


@dataclass(frozen=True, slots=True)
class _HeapEntry:
    ready_at: float
    priority: int
    sequence: int
    task_id: TaskId
    revision: int


@dataclass(slots=True)
class _TaskEntry:
    task_id: TaskId
    priority: int
    ready_at: float
    dependencies: tuple[TaskId, ...]
    successors: set[TaskId]
    revision: int
    pending_dependencies: int
    state: TaskState
    claim_token: str | None


class TaskScheduler(Generic[TaskId]):
    """Maintain an in-memory task graph and claim the next executable task.

    A re-entrant lock protects scheduler state. Execution never runs while the
    lock is held. Claiming is a short lock acquisition plus an ``O(log R)``
    ready-heap operation, where ``R`` is the number of executable tasks.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] | None = None,
        allow_cycles: bool = False,
    ) -> None:
        self._clock = clock or time.monotonic
        self._allow_cycles = bool(allow_cycles)
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._tasks: dict[TaskId, _TaskEntry] = {}
        self._reverse_dependencies: dict[TaskId, set[TaskId]] = {}
        self._ready_heap: list[_HeapEntry] = []
        self._due_heap: list[_HeapEntry] = []
        self._blocked_heap: list[_HeapEntry] = []
        self._sequence = 0

    @property
    def task_count(self) -> int:
        """Number of registered task IDs, including terminal tasks."""

        with self._lock:
            return len(self._tasks)

    @property
    def ready_task_count(self) -> int:
        """Number of currently claimable tasks."""

        with self._lock:
            return len(self._ready_heap)

    @property
    def pending_task_count(self) -> int:
        """Number of tasks not currently claimable."""

        with self._lock:
            return self.task_count - self.ready_task_count

    def clock(self) -> float:
        """Return the scheduler's injected or monotonic clock value."""

        with self._lock:
            return self._clock()

    def register_task(self, task: Task[TaskId]) -> TaskRecord[TaskId]:
        """Register one task atomically."""

        with self._lock:
            self._validate_task_id_available(task.task_id)
            self._validate_dependencies_available(task.dependencies)
            graph = {
                task_id: record.dependencies
                for task_id, record in self._tasks.items()
            }
            graph[task.task_id] = task.dependencies
            self._validate_cycle_locked(graph, {task.task_id})

            record = self._new_record(
                task,
                dependencies=task.dependencies,
            )
            self._insert_record_locked(record)
            self._condition.notify_all()
            return self._snapshot(record)

    def register_tasks(
        self, tasks: Iterable[Task[TaskId]]
    ) -> None:
        """Register a graph in one atomic operation.

        Dependencies may refer to tasks that occur later in the batch. Duplicate
        IDs and a cycle in strict mode are rejected without inserting any task.
        """

        submitted = tuple(tasks)
        by_id: dict[TaskId, Task[TaskId]] = {}
        for task in submitted:
            self._validate_task_id_available(task.task_id)
            previous = by_id.get(task.task_id)
            if previous is not None:
                raise TaskUpdateError(
                    f"duplicate task id {task.task_id!r} in registration batch"
                )
            by_id[task.task_id] = task

        with self._lock:
            for task in submitted:
                existing = set(self._tasks) | set(by_id)
                self._validate_dependencies_available(task.dependencies, existing)

            graph = {
                task_id: record.dependencies
                for task_id, record in self._tasks.items()
            }
            for task in submitted:
                graph[task.task_id] = task.dependencies
            self._validate_cycle_locked(graph, {task.task_id for task in submitted})

            records = {
                task.task_id: self._new_record(task, dependencies=task.dependencies)
                for task in submitted
            }
            for record in records.values():
                self._tasks[record.task_id] = record
                for dependency in record.dependencies:
                    self._tasks[dependency].successors.add(record.task_id)

            now = self._now_locked()
            for record in records.values():
                self._set_pending_count_locked(record, record.task_id, now)
            self._condition.notify_all()

    def replace_dependencies_batch(
        self, dependencies: Mapping[TaskId, Iterable[TaskId]]
    ) -> dict[TaskId, TaskRecord[TaskId]]:
        """Atomically replace each supplied task's dependency list."""

        supplied = dict(dependencies)
        with self._lock:
            updates = {
                task_id: TaskUpdate(dependencies=dependency_ids)
                for task_id, dependency_ids in supplied.items()
            }
            return self._update_tasks_locked(updates)

    def update_task(self, task_id: TaskId, update: TaskUpdate) -> TaskRecord[TaskId]:
        """Atomically apply one partial task update."""

        with self._lock:
            return self._update_tasks_locked({task_id: update})[task_id]

    def update_tasks(
        self, updates: Mapping[TaskId, TaskUpdate]
    ) -> dict[TaskId, TaskRecord[TaskId]]:
        """Atomically apply a batch of task updates."""

        supplied = dict(updates)
        with self._lock:
            return self._update_tasks_locked(supplied)

    def peek_next(self) -> TaskRecord[TaskId] | None:
        """Return the next executable record without claiming it."""

        with self._lock:
            self._promote_due_locked()
            self._clean_ready_heap_locked()
            if not self._ready_heap:
                return None
            entry = self._ready_heap[0]
            return self._snapshot(self._tasks[entry.task_id])

    def next_task(self) -> TaskRecord[TaskId] | None:
        """Claim and return the next executable task.

        Pass the returned ``claim_token`` to ``complete``, ``fail``, or
        ``retry``. A token resolves exactly one lease.
        """

        with self._lock:
            self._promote_due_locked()
            self._clean_ready_heap_locked()
            while self._ready_heap:
                entry = heapq.heappop(self._ready_heap)
                self._clean_ready_heap_locked()
                record = self._tasks.get(entry.task_id)
                if record is None or record.revision != entry.revision:
                    continue
                if record.state is not TaskState.READY:
                    continue
                claimed = replace(
                    record,
                    state=TaskState.CLAIMED,
                    claim_token=uuid.uuid4().hex,
                )
                self._tasks[entry.task_id] = claimed
                return self._snapshot(claimed)
            return None

    def complete(
        self,
        task_id: TaskId,
        *,
        lease_token: str,
    ) -> TaskRecord[TaskId]:
        """Mark a claimed task as successfully completed."""

        with self._lock:
            entry = self._tasks.get(task_id)
            if entry is None:
                raise UnknownTaskError(f"unknown task {task_id!r}")
            self._validate_claim(entry, task_id, lease_token)
            completed = replace(
                entry,
                state=TaskState.SUCCEEDED,
                claim_token=None,
            )
            self._tasks[task_id] = completed
            self._successors_of_completed(task_id)
            self._condition.notify_all()
            return self._snapshot(completed)

    def fail(
        self,
        task_id: TaskId,
        *,
        lease_token: str,
    ) -> TaskRecord[TaskId]:
        """Mark a claimed task as failed and leave dependents blocked."""

        with self._lock:
            entry = self._tasks.get(task_id)
            if entry is None:
                raise UnknownTaskError(f"unknown task {task_id!r}")
            self._validate_claim(entry, task_id, lease_token)
            failed = replace(
                entry,
                state=TaskState.FAILED,
                claim_token=None,
            )
            self._tasks[task_id] = failed
            self._condition.notify_all()
            return self._snapshot(failed)

    def retry(
        self,
        task_id: TaskId,
        *,
        lease_token: str,
        ready_at: float | None = None,
    ) -> TaskRecord[TaskId]:
        """Move a failed task back to scheduling with a new lease.

        Existing dependencies are retained. Dependents remain blocked until a
        retried task succeeds.
        """

        with self._lock:
            entry = self._tasks.get(task_id)
            if entry is None:
                raise UnknownTaskError(f"unknown task {task_id!r}")
            self._validate_claim(entry, task_id, lease_token)
            timestamp = (
                entry.ready_at
                if ready_at is None
                else _coerce_timestamp(ready_at)
            )
            updated = replace(
                entry,
                state=TaskState.SCHEDULED,
                revision=entry.revision + 1,
                claim_token=None,
                ready_at=timestamp,
            )
            self._tasks[task_id] = updated
            self._place_record_locked(updated)
            self._condition.notify_all()
            return self._snapshot(updated)

    def has_cycle(self) -> bool:
        """Return whether the current dependency graph contains any cycle."""

        with self._lock:
            graph = {
                task_id: record.dependencies
                for task_id, record in self._tasks.items()
            }
            return _find_cycle_from_locked(graph) is not None

    def find_cycle(self, task_id: TaskId) -> tuple[TaskId, ...] | None:
        """Return a cycle containing ``task_id``, or ``None`` if none."""

        with self._lock:
            if task_id not in self._tasks:
                raise UnknownTaskError(f"unknown task {task_id!r}")
            graph = {
                task_id: record.dependencies
                for task_id, record in self._tasks.items()
            }
            return _find_cycle_from_locked(graph, task_id)

    def get_task_record(self, task_id: TaskId) -> TaskRecord[TaskId]:
        """Return an immutable snapshot for a registered task."""

        with self._lock:
            if task_id not in self._tasks:
                raise UnknownTaskError(f"unknown task {task_id!r}")
            return self._snapshot(self._tasks[task_id])

    def wait_for_next(self, timeout: float | None = None) -> bool:
        """Wait for a claimable task without claiming it."""

        if timeout is not None and timeout < 0:
            raise ValueError("timeout must be non-negative or None")

        deadline = None if timeout is None else time.monotonic() + timeout
        with self._condition:
            while True:
                now = self._now_locked()
                self._promote_due_locked()
                if self._ready_heap:
                    return True
                if timeout == 0:
                    return False

                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False

                if self._due_heap and self._due_heap[0].ready_at > now:
                    wait_for = min(
                        self._due_heap[0].ready_at - now,
                        float(remaining) if remaining is not None else math.inf,
                    )
                    if wait_for > 0:
                        self._condition.wait(timeout=wait_for)
                        continue

                # Tasks blocked by dependencies are promoted by a completion
                # or update event. A fake/injected clock needs an explicit
                # scheduler call, so an indefinite wait is the only non-spinning
                # choice when no real-time deadline is available.
                self._condition.wait(timeout=remaining)

    # ------------------------------------------------------------------
    # Graph mutation helpers
    # ------------------------------------------------------------------

    def _new_record(
        self,
        task: Task[TaskId],
        *,
        dependencies: tuple[TaskId, ...],
    ) -> _TaskEntry:
        return _TaskEntry(
            task_id=task.task_id,
            priority=task.priority,
            ready_at=task.ready_at,
            dependencies=dependencies,
            successors=set(),
            revision=0,
            pending_dependencies=0,
            state=TaskState.SCHEDULED,
            claim_token=None,
        )

    def _validate_task_id_available(self, task_id: TaskId) -> None:
        if task_id in self._tasks:
            raise TaskUpdateError(f"task {task_id!r} is already registered")

    def _validate_dependencies_available(
        self, dependencies: Iterable[TaskId], existing_ids: Iterable[TaskId]
    ) -> None:
        existing = set(existing_ids)
        for dependency in dependencies:
            if dependency not in existing:
                raise UnknownTaskError(
                    f"task depends on unknown dependency {dependency!r}"
                )

    def _insert_record_locked(self, record: _TaskEntry) -> None:
        self._tasks[record.task_id] = record
        for dependency in record.dependencies:
            self._tasks[dependency].successors.add(record.task_id)
        self._set_pending_count_locked(record, record.task_id, self._now_locked())

    def _update_tasks_locked(
        self, updates: Mapping[TaskId, TaskUpdate]
    ) -> dict[TaskId, TaskRecord[TaskId]]:
        if not updates:
            return {}

        supplied_ids = tuple(updates)
        for task_id in supplied_ids:
            if task_id not in self._tasks:
                raise UnknownTaskError(f"unknown task {task_id!r}")
            record = self._tasks[task_id]
            if record.state not in (TaskState.SCHEDULED, TaskState.READY):
                raise InvalidTaskStateError(
                    f"task {task_id!r} is not schedulable"
                )

        changes: dict[TaskId, tuple[TaskId, ...]] = {}
        for task_id, update in updates.items():
            if update.dependencies is not None:
                dependencies = update.dependencies
                changes[task_id] = dependencies
                if any(dependency == task_id for dependency in dependencies):
                    raise TaskUpdateError(
                        f"task {task_id!r} cannot depend on itself"
                    )
                if any(dependency not in self._tasks for dependency in dependencies):
                    raise UnknownTaskError(
                        f"task {task_id!r} references unknown dependency {dependency!r}"
                    )

        self._validate_cycle_locked(changes, supplied_ids)
        old_records = {
            task_id: self._tasks[task_id] for task_id in supplied_ids
        }
        now = self._now_locked()
        new_records: dict[TaskId, _TaskEntry] = {}
        for task_id, old in old_records.items():
            update = updates[task_id]
            dependencies = changes.get(task_id, old.dependencies)
            timestamp = (
                update.ready_at
                if update.ready_at is not None
                else old.ready_at
            )
            priority = (
                update.priority
                if update.priority is not None
                else old.priority
            )
            new_records[task_id] = _TaskEntry(
                task_id=task_id,
                priority=priority,
                ready_at=timestamp,
                dependencies=dependencies,
                successors=set(),
                revision=old.revision + 1,
                pending_dependencies=old.pending_dependencies,
                state=TaskState.SCHEDULED,
                claim_token=None,
            )

        for task_id in supplied_ids:
            old = old_records[task_id]
            for dependency in old.dependencies:
                dependents = self._reverse_dependencies.get(dependency)
                if dependents is not None:
                    dependents.discard(task_id)
                    if not dependents:
                        del self._reverse_dependencies[dependency]
            for dependency in new_records[task_id].dependencies:
                self._reverse_dependencies.setdefault(dependency, set()).add(task_id)

        for task_id in supplied_ids:
            self._tasks[task_id] = new_records[task_id]

        for task_id in supplied_ids:
            self._set_pending_count_locked(new_records[task_id], task_id, now)

        self._condition.notify_all()
        return {
            task_id: self._snapshot(new_records[task_id])
            for task_id in supplied_ids
        }

    def _set_pending_count_locked(
        self,
        record: _TaskEntry,
        task_id: TaskId,
        now: float,
    ) -> None:
        count = sum(
            1
            for dependency in record.dependencies
            if self._tasks[dependency].state is not TaskState.SUCCEEDED
        )
        record.pending_dependencies = count
        if count == 0 and record.ready_at <= now:
            record.state = TaskState.READY
        else:
            record.state = TaskState.SCHEDULED
        self._tasks[task_id] = record
        self._place_record_locked(record)

    def _successors_of_completed(self, completed_id: TaskId) -> None:
        dependents = self._reverse_dependencies.get(completed_id, set())
        for dependent_id in dependents:
            old = self._tasks[dependent_id]
            if old.state is not TaskState.SCHEDULED:
                continue
            new_pending = old.pending_dependencies - 1
            if new_pending < 0:
                raise RuntimeError(
                    f"pending dependency count underflow for {dependent_id!r}"
                )
            self._tasks[dependent_id] = replace(
                old,
                revision=old.revision + 1,
                pending_dependencies=new_pending,
            )
            self._set_pending_count_locked(old, dependent_id, self._now_locked())
        if dependents:
            self._condition.notify_all()

    # ------------------------------------------------------------------
    # Index maintenance
    # ------------------------------------------------------------------

    def _place_record_locked(self, record: _TaskEntry) -> None:
        if record.state is TaskState.READY:
            self._insert_ready_locked(record)
        elif record.state is TaskState.SCHEDULED:
            if record.pending_dependencies == 0:
                self._insert_due_locked(record)
            else:
                self._insert_blocked_locked(record)

    def _insert_ready_locked(self, record: _TaskEntry) -> None:
        if record.state is not TaskState.READY:
            self._tasks[record.task_id] = replace(record, state=TaskState.READY)
        if record.task_id not in self._ready_heap_by_id:
            self._entry(record, ready=True)

    def _insert_due_locked(self, record: _TaskEntry) -> None:
        if record.task_id not in self._due_heap_by_id:
            self._entry(record, ready=False)

    def _insert_blocked_locked(self, record: _TaskEntry) -> None:
        if record.task_id not in self._blocked_heap_by_id:
            self._entry(record, ready=False)

    def _promote_due_locked(self) -> None:
        now = self._now_locked()
        ready_entries: list[_HeapEntry] = []
        blocked_entries: list[_HeapEntry] = []
        future_entries: list[_HeapEntry] = []

        while self._due_heap and self._due_heap[0].ready_at <= now:
            entry = heapq.heappop(self._due_heap)
            self._due_heap_by_id.pop(entry.task_id, None)
            record = self._tasks.get(entry.task_id)
            if record is None or record.revision != entry.revision:
                continue
            if record.state is not TaskState.SCHEDULED or record.pending_dependencies != 0:
                if record.pending_dependencies == 0:
                    self._insert_due_locked(record)
                else:
                    self._insert_blocked_locked(record)
                continue
            if record.ready_at <= now:
                self._insert_ready_locked(record)
                ready_entries.append(self._entry(record))
            else:
                self._insert_due_locked(record)
                future_entries.append(self._entry(record))

        # Do not scan the blocked index: dependency completion promotes those
        # tasks immediately and timestamp changes only matter after they become
        # dependency-free.
        self._ready_heap = ready_entries + self._ready_heap
        self._blocked_heap = blocked_entries + self._blocked_heap
        self._future_heap = future_entries + self._future_heap
        heapq.heapify(self._ready_heap)
        heapq.heapify(self._blocked_heap)
        heapq.heapify(self._future_heap)

    def _clean_ready_heap_locked(self) -> None:
        while self._ready_heap:
            entry = self._ready_heap[0]
            record = self._tasks.get(entry.task_id)
            stale = (
                record is None
                or record.revision != entry.revision
                or record.state is not TaskState.READY
            )
            if stale:
                heapq.heappop(self._ready_heap)
            else:
                return

    def _validate_cycle_locked(
        self,
        overrides: Mapping[TaskId, tuple[TaskId, ...]],
        changed_sources: Iterable[TaskId],
    ) -> None:
        if self._allow_cycles:
            return
        graph = {
            task_id: overrides.get(task_id, record.dependencies)
            for task_id, record in self._tasks.items()
        }
        for task_id in overrides:
            graph[task_id] = overrides[task_id]
        cycle = _find_cycle_from_locked(graph, next(iter(changed_sources)))
        if cycle is not None:
            source = next(iter(changed_sources))
            raise DependencyCycleError(
                f"dependency update creates a cycle involving task {source!r}"
            )

    def _find_cycle_from_locked(
        self, start: TaskId, overrides: Mapping[TaskId, tuple[TaskId, ...]] | None
    ) -> tuple[TaskId, ...] | None:
        if overrides is None:
            graph = {
                task_id: record.dependencies
                for task_id, record in self._tasks.items()
            }
            return _find_cycle_from_locked(graph, start)

        colour: dict[TaskId, int] = {}
        path: list[TaskId] = []
        path_positions: dict[TaskId, int] = {}
        stack: list[tuple[TaskId, int]] = [(start, 0)]
        colour[start] = 1
        path_positions[start] = 0

        while stack:
            task_id, index = stack[-1]
            dependencies = overrides.get(task_id, self._tasks[task_id].dependencies)
            if index < len(dependencies):
                dependency = dependencies[index]
                stack[-1] = (task_id, index + 1)
                if dependency == start:
                    return tuple(path + [start])
                state = colour.get(dependency, 0)
                if state == 0:
                    colour[dependency] = 1
                    path_positions[dependency] = len(path)
                    path.append(dependency)
                    stack.append((dependency, 0))
                elif state == 1:
                    position = path_positions.get(dependency)
                    if position is not None:
                        return tuple(path[position:] + [dependency])
                continue

            colour[task_id] = 2
            path_positions.pop(task_id, None)
            path.pop()
            stack.pop()
        return None

    def _validate_claim(
        self, record: _TaskEntry, task_id: TaskId, lease_token: str
    ) -> None:
        if lease_token != record.claim_token:
            raise InvalidTaskStateError(
                f"claim token for task {task_id!r} is invalid or expired"
            )
        if record.state is not TaskState.CLAIMED:
            raise InvalidTaskStateError(f"task {task_id!r} is not claimed")

    def _entry(self, record: _TaskEntry, *, ready: bool) -> _HeapEntry:
        self._sequence += 1
        if ready:
            self._ready_heap.append(
                _HeapEntry(
                    ready_at=record.ready_at,
                    priority=record.priority,
                    sequence=self._sequence,
                    task_id=record.task_id,
                    revision=record.revision,
                )
            )
        elif record.pending_dependencies == 0:
            self._due_heap.append(
                _HeapEntry(
                    ready_at=record.ready_at,
                    priority=record.priority,
                    sequence=self._sequence,
                    task_id=record.task_id,
                    revision=record.revision,
                )
            )
        else:
            self._blocked_heap.append(
                _HeapEntry(
                    ready_at=record.ready_at,
                    priority=record.priority,
                    sequence=self._sequence,
                    task_id=record.task_id,
                    revision=record.revision,
                )
            )
        return self._heap_entry_for(record, ready)

    def _heap_entry_for(self, record: _TaskEntry, ready: bool) -> _HeapEntry:
        return _HeapEntry(
            ready_at=record.ready_at,
            priority=record.priority,
            sequence=self._sequence,
            task_id=record.task_id,
            revision=record.revision,
        )

    def _snapshot(self, entry: _TaskEntry) -> TaskRecord[TaskId]:
        return TaskRecord(
            task_id=entry.task_id,
            priority=entry.priority,
            execution_timestamp=entry.ready_at,
            dependencies=entry.dependencies,
            state=entry.state,
            revision=entry.revision,
            pending_dependencies=entry.pending_dependencies,
            claim_token=entry.claim_token,
        )


def _coerce_priority(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("task priority must be an integer")
    return value


def _coerce_timestamp(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("ready_at must be a real number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("ready_at must be finite")
    return result


def _normalise_dependencies(dependencies: Iterable[TaskId]) -> tuple[TaskId, ...]:
    result: list[TaskId] = []
    seen: set[TaskId] = set()
    for dependency in dependencies:
        if dependency not in seen:
            result.append(dependency)
            seen.add(dependency)
    return tuple(result)


def _find_cycle_from_locked(
    graph: Mapping[TaskId, tuple[TaskId, ...]], start: TaskId
) -> tuple[TaskId, ...] | None:
    colour: dict[TaskId, int] = {}
    path: list[TaskId] = []
    path_positions: dict[TaskId, int] = {}
    stack: list[tuple[TaskId, int]] = [(start, 0)]
    colour[start] = 1
    path_positions[start] = 0

    while stack:
        task_id, index = stack[-1]
        dependencies = graph.get(task_id, ())
        if index < len(dependencies):
            dependency = dependencies[index]
            stack[-1] = (task_id, index + 1)
            if dependency == start:
                return tuple(path + [start])
            state = colour.get(dependency, 0)
            if state == 0:
                colour[dependency] = 1
                path_positions[dependency] = len(path)
                path.append(dependency)
                stack.append((dependency, 0))
            elif state == 1:
                position = path_positions.get(dependency)
                if position is not None:
                    return tuple(path[position:] + [dependency])
            continue

        colour[task_id] = 2
        path_positions.pop(task_id, None)
        path.pop()
        stack.pop()
    return None
