"""In-memory priority task scheduler.

A self-contained, single-consumer scheduler supporting up to a million tasks.
Design rationale, complexity analysis, edge cases, and a usage example live in
``README.rst``. This module is the implementation.

Model
=====
Each live task lives in exactly one of two buckets:

* **ready heap** when ``PENDING`` (executable: no unresolved dependencies);
* **dict-only** when ``WAITING`` (blocked on one or more dependencies).

``RUNNING`` tasks are *consumed* from the ready heap, so they are never
resident. This bijection makes ``next_task`` ``O(log n)`` and keeps dependency
resolution at a single ``O(log n)`` heap push.

``task.deps`` is the single source of truth: the set of *unresolved*
dependencies. It drives both scheduling (a task is ``PENDING`` iff its
dependencies are empty) and cycle detection (a cycle can only form among live
edges, and DONE edges are pruned from ``deps`` as they resolve).

Ordering
========
"Next" is the executable task with the soonest ``due`` time, ties broken by
descending ``priority`` then insertion order. ``due`` is POSIX epoch seconds; a
task is time-gated until its ``due`` passes.

Lifecycle
=========
``next_task`` marks a task ``RUNNING`` (consuming it). ``done_task`` and
``fail_task`` require a prior ``RUNNING`` step. ``cancel_task`` ends a task and
transitively cancels its dependents. A failed parent's dependents cascade-fail.

Thread-safety
=============
Intentionally **not thread-safe** (see README). Designed for a single consumer
thread.
"""

from __future__ import annotations

import heapq
import threading
import time
import uuid
from datetime import timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

from .errors import AlreadyExistsError, TaskNotFoundError
from .task import (
    _GONE_STATES as GONE_STATES,
    LIVE_STATES,
    Priority,
    Task,
    TaskInput,
    TaskState,
    norm_priority,
)

__all__ = ["Scheduler"]

# Higher number == more severe. Used to merge cascades (FAILED > CANCELLED > DEPRECATED).
SEVERITY: Dict[TaskState, int] = {
    TaskState.DEPRECATED: 1,
    TaskState.CANCELLED: 2,
    TaskState.FAILED: 3,
}

_HeapEntry = Tuple[float, int, int, str]  # (due, -priority, rseq, tid)


class Scheduler:
    """In-memory priority task scheduler."""

    def __init__(self) -> None:
        self._tasks: Dict[str, Task] = {}
        self._watchers: Dict[str, List[str]] = {}  # parent -> dependents
        self._ready_heap: List[_HeapEntry] = []  # PENDING tasks only
        self._rseq: int = 0
        self._timer: Optional[threading.Timer] = None
        self._timer_lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # id + time helpers
    # ------------------------------------------------------------------ #
    def _new_id(self) -> str:
        while True:
            tid = f"t-{uuid.uuid4().hex[:12]}"
            if tid not in self._tasks:
                return tid

    def _new_rseq(self) -> int:
        self._rseq += 1
        return self._rseq

    def _as_time(self, due: Any) -> float:
        if due is None:
            return time.time()
        if isinstance(due, timedelta):
            return time.time() + due.total_seconds()
        if isinstance(due, (int, float)) and not isinstance(due, bool):
            return float(due)
        raise TypeError(
            f"due must be None, a number (epoch seconds), or timedelta, "
            f"got {type(due).__name__}"
        )

    def _live(self, tid: str) -> bool:
        t = self._tasks.get(tid)
        return t is not None and t.state not in GONE_STATES

    # ------------------------------------------------------------------ #
    # cycle detection
    # ------------------------------------------------------------------ #
    def _reaches_from(self, start_deps: Set[str], target_id: str) -> None:
        """Raise ``ValueError`` if ``target_id`` is reachable from any of
        ``start_deps`` by following the *current* dependency edges.

        Used at insert time and after dependency updates. We walk out from
        ``start_deps`` and stop as soon as we reach ``target_id``. O(edges).
        """
        seen: Set[str] = set()
        stack = list(start_deps)
        while stack:
            cur = stack.pop()
            if cur == target_id:
                raise ValueError("dependency cycle detected")
            if cur in seen:
                continue
            seen.add(cur)
            dep = self._tasks.get(cur)
            if dep is not None:
                stack.extend(dep.deps)

    # ------------------------------------------------------------------ #
    # terminal-state cascade helpers
    # ------------------------------------------------------------------ #
    def _pick_terminal(self, task: Task) -> Optional[TaskState]:
        """Most-severe terminal state among ``task``'s remaining deps, or None."""
        best: Optional[TaskState] = None
        for d in task.deps:
            t = self._tasks.get(d)
            st = t.state if t is not None else None
            if st in SEVERITY:
                if best is None or SEVERITY[st] > SEVERITY[best]:
                    best = st
        return best

    @staticmethod
    def _merge(bad: Optional[TaskState], marker_state: TaskState) -> Optional[TaskState]:
        """Combine a child's *other* terminal deps with the just-resolved
        ``marker_state`` (DONE contributes nothing)."""
        if marker_state == TaskState.DONE:
            return bad
        if bad is None:
            return marker_state
        return (
            bad
            if SEVERITY.get(bad, 0) >= SEVERITY.get(marker_state, 0)
            else marker_state
        )

    # ------------------------------------------------------------------ #
    # heap bookkeeping
    # ------------------------------------------------------------------ #
    def _enqueue(self, task: Task) -> None:
        """Push a fresh valid ready-heap entry for ``task``.

        The key ``(due, -priority, rseq, tid)`` makes the min-heap return the
        soonest ``due`` first, ties broken by descending ``priority`` (higher
        == more urgent), then insertion order via ``rseq``.
        """
        rseq = self._new_rseq()
        task.heap_mark = rseq
        heapq.heappush(
            self._ready_heap,
            (task.due, -task.priority, rseq, task.tid),
        )

    def _demote(self, task: Task) -> None:
        """Invalidate ``task``'s current ready-heap entry (lazily dropped)."""
        task.heap_mark = 0

    def _prune_top(self) -> None:
        """Drop stale entries sitting on the top of the ready heap."""
        heap = self._ready_heap
        while heap:
            _, _, _, tid = heap[0]
            task = self._tasks.get(tid)
            if task is not None and task.heap_mark == heap[0][2]:
                return
            heapq.heappop(heap)

    # ------------------------------------------------------------------ #
    # insertion
    # ------------------------------------------------------------------ #
    def add_task(
        self,
        label: str,
        priority: Any = None,
        due: Any = None,
        depends_on: Any = None,
        task_id: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Register a task and return its unique id.

        ``priority`` may be a :class:`~scheduler.task.Priority`, an ``int``, or
        ``None`` (``Priority.NORMAL``). ``due`` may be ``None`` (now), a numeric
        epoch, or a :class:`datetime.timedelta`. ``depends_on`` is a list/set of
        ids that must complete before this task is executable.

        Raises :class:`TaskNotFoundError` for a bad dependency id and
        :class:`AlreadyExistsError` / :class:`ValueError` for a bad id, a
        self-dependency, or a dependency cycle.
        """
        if isinstance(label, TaskInput):
            inp: TaskInput = label
            if priority is None:
                priority = inp.priority
            if due is None:
                due = inp.due
            if depends_on is None:
                depends_on = inp.depends_on
            if meta is None:
                meta = inp.meta
            label = inp.label
        else:
            inp = TaskInput(
                label=label,
                priority=priority,
                due=due,
                depends_on=depends_on if depends_on is not None else (),
                meta=meta if meta is not None else {},
            )

        prio = norm_priority(Priority.NORMAL if priority is None else priority)
        due_f = self._as_time(inp.validated_due())
        raw_deps = list(depends_on) if depends_on is not None else []

        tid = task_id if task_id is not None else label
        if tid in self._tasks:
            raise AlreadyExistsError(tid)

        self._validate_dependencies(tid, raw_deps)

        deps: Set[str] = set(raw_deps)

        task = Task(
            tid=tid,
            label=inp.label,
            priority=prio,
            due=due_f,
            depends_on=tuple(deps),
            meta=dict(inp.meta),
            deps=set(deps),
        )

        self._tasks[tid] = task
        self._watchers[tid] = []
        for dep in deps:
            self._watchers.setdefault(dep, [])
            if tid not in self._watchers[dep]:
                self._watchers[dep].append(tid)

        self._reclassify(task)
        return tid

    def _validate_dependencies(self, tid: str, deps: List[str]) -> None:
        if tid in deps:
            raise ValueError(f"Task {tid!r} cannot depend on itself")
        for dep in deps:
            if dep not in self._tasks:
                raise TaskNotFoundError(dep)

    def _reclassify(self, task: Task) -> None:
        """Set ``task``'s state and enqueue/demote as appropriate.

        Prunes resolved (DONE) edges first. If any remaining dependency is
        terminal the child takes the most-severe terminal state (cascade).
        Otherwise it is ``WAITING`` (dict-only) or ``PENDING`` (heap-resident).
        """
        bad = self._pick_terminal(task)
        if bad is not None:
            task.state = bad
            task.deps = set()
            task.heap_mark = 0
            return

        for d in list(task.deps):
            t = self._tasks.get(d)
            if t is not None and t.state == TaskState.DONE:
                task.deps.discard(d)

        if task.deps:
            task.state = TaskState.WAITING
            self._demote(task)
        else:
            task.state = TaskState.PENDING
            # Enqueue unless the task already holds a valid heap entry
            # (heap_mark == 0 means "not resident"); this keeps fresh PENDING
            # tasks scheduled and WAITING->PENDING transitions enqueued, while
            # never creating a duplicate entry for an already-queued task.
            if task.heap_mark == 0:
                self._enqueue(task)

    # ------------------------------------------------------------------ #
    # next_task
    # ------------------------------------------------------------------ #
    def next_task(self) -> Optional[str]:
        """Return the id of the next task to execute, or ``None``.

        Marks the task ``RUNNING`` and updates ``started``. If the soonest
        executable task is time-gated, ``None`` is returned without consuming it.
        """
        self._prune_top()
        if not self._ready_heap:
            return None

        now = time.time()
        if self._ready_heap[0][0] <= now:
            _, _, _, tid = heapq.heappop(self._ready_heap)
            task = self._tasks[tid]
            task.heap_mark = 0
            task.state = TaskState.RUNNING
            task.started = now
            task.exec_count += 1
            return tid
        return None

    def peek_next_task(self) -> Optional[str]:
        """Return the next task id without consuming it.

        ``None`` when nothing is executable *yet* (the soonest task is
        time-gated). Idempotent.
        """
        self._prune_top()
        if not self._ready_heap:
            return None
        if self._ready_heap[0][0] <= time.time():
            return self._ready_heap[0][3]
        return None

    def earliest_run_time(self) -> Optional[float]:
        """Earliest ``due`` among executable tasks, or ``None`` if none."""
        self._prune_top()
        return self._ready_heap[0][0] if self._ready_heap else None

    def ready_count(self) -> int:
        """Number of valid executable (``PENDING``) tasks currently queued."""
        self._prune_top()
        return len(self._ready_heap)

    # ------------------------------------------------------------------ #
    # lifecycle transitions
    # ------------------------------------------------------------------ #
    def done_task(self, tid: str, *, deprecated: bool = False) -> None:
        """Mark a task done and wake its dependents.

        The task must be ``RUNNING`` (fetched via :meth:`next_task`); calling on
        a never-fetched task raises :class:`RuntimeError`. A task already ``DONE``
        raises :class:`ValueError` unless ``deprecated=True``.
        """
        task = self._tasks.get(tid)
        if task is None:
            raise TaskNotFoundError(tid)

        if task.state == TaskState.DEPRECATED:
            raise ValueError(f"Task {tid!r} is already deprecated")
        if task.state == TaskState.DONE:
            if deprecated:
                task.state = TaskState.DEPRECATED
                task.finished = time.time()
                self._wakeup_dependents([tid])
            else:
                raise ValueError(f"Task {tid!r} already done")
        if task.state != TaskState.RUNNING:
            raise RuntimeError(
                f"done_task called on task {tid!r} in state {task.state.value}; "
                "must be RUNNING (fetched via next_task) first"
            )

        task.state = TaskState.DEPRECATED if deprecated else TaskState.DONE
        task.finished = time.time()
        task.heap_mark = 0
        self._wakeup_dependents([tid])

    def fail_task(self, tid: str, message: Optional[str] = None) -> None:
        """Mark a task failed; dependents behind a failed dep are cascade-failed."""
        task = self._tasks.get(tid)
        if task is None:
            raise TaskNotFoundError(tid)
        if task.state in (TaskState.FAILED, TaskState.DEPRECATED):
            raise ValueError(f"Task {tid!r} already terminal")
        if task.state != TaskState.RUNNING:
            raise RuntimeError(
                f"fail_task called on task {tid!r} in state {task.state.value}; "
                "must be RUNNING first"
            )
        task.state = TaskState.FAILED
        task.finished = time.time()
        task.meta["_fail_message"] = message
        task.heap_mark = 0
        self._wakeup_dependents([tid])

    def cancel_task(self, tid: str) -> None:
        """Cancel a task *and* its dependents (transitively) via cascade."""
        task = self._tasks.get(tid)
        if task is None:
            raise TaskNotFoundError(tid)
        task.state = TaskState.CANCELLED
        task.deps = set()
        task.heap_mark = 0
        self._wakeup_dependents([tid])

    # ------------------------------------------------------------------ #
    # dependent wakeups
    # ------------------------------------------------------------------ #
    def _wakeup_dependents(self, affected: List[str]) -> None:
        """Propagate terminal transitions down the dependency DAG.

        For each affected marker we examine its dependents:

        * discard the resolved edge;
        * if the resolved marker is terminal (``FAILED``/``CANCELLED``/
          ``DEPRECATED``) or any *other* remaining dep is terminal, cascade the
          most-severe terminal state to the child (re-walking it);
        * otherwise, if the child still has live deps it becomes ``WAITING``
          (dict-only); if all deps are gone it becomes ``PENDING`` and is
          promoted into the ready heap with a single ``O(log n)`` push.
        """
        stack: List[str] = list(affected)
        while stack:
            mid = stack.pop()
            marker = self._tasks.get(mid)
            if marker is None or marker.state not in GONE_STATES:
                continue
            for cid in list(self._watchers.get(mid, ())):
                child = self._tasks.get(cid)
                if child is None or child.state in GONE_STATES:
                    continue
                if mid not in child.deps:
                    continue  # edge already resolved
                child.deps.discard(mid)

                overall = self._merge(self._pick_terminal(child), marker.state)
                if overall is not None:
                    child.state = overall
                    child.deps = set()
                    child.heap_mark = 0
                    stack.append(cid)
                    continue

                if child.deps:
                    child.state = TaskState.WAITING
                    self._demote(child)
                else:
                    child.state = TaskState.PENDING
                    self._enqueue(child)

    # ------------------------------------------------------------------ #
    # update_task
    # ------------------------------------------------------------------ #
    def update_task(
        self,
        tid: str,
        *,
        label: Optional[str] = None,
        priority: Any = None,
        due: Any = None,
        depends_on: Any = None,
    ) -> None:
        """Dynamically update a live task's label/priority/due/dependencies.

        Missing values leave the field unchanged. Dependency changes are fully
        reconciled (promote/demote the task and re-walk dependents). Raises
        :class:`TaskNotFoundError` for an unknown id, :class:`ValueError` for a
        self-dependency / cycle, and :class:`RuntimeError` for a terminal task.
        """
        task = self._tasks.get(tid)
        if task is None:
            raise TaskNotFoundError(tid)
        if task.state in (TaskState.DONE, TaskState.FAILED, TaskState.DEPRECATED):
            raise RuntimeError(f"cannot update a task in state {task.state.value}")

        deps_before = set(task.deps)

        if label is not None:
            task.label = label
            task.updated = time.time()

        if priority is not None:
            new_priority = norm_priority(priority)
            if new_priority != task.priority:
                task.priority = new_priority

        if due is not None:
            new_due = self._as_time(due)
            if new_due != task.due:
                task.due = new_due

        if depends_on is not None:
            new_deps = set(depends_on)
            if new_deps != deps_before:
                # Cycle check BEFORE mutating the graph.
                self._validate_dependencies(tid, list(new_deps))
                self._reaches_from(new_deps, tid)
                self._detach_deps(task, deps_before)
                self._add_deps(task, new_deps)
                self._reclassify(task)
                return

        if priority is not None or due is not None:
            # Only executable tasks (no unresolved deps) carry a heap entry.
            # Refresh their heap position; a WAITING task picks up the new
            # priority/due when its dependencies resolve. Re-enqueuing a task
            # that was RUNNING sends it back to the ready set (PENDING).
            if not task.deps:
                self._demote(task)
                self._enqueue(task)
                if task.state == TaskState.RUNNING:
                    task.state = TaskState.PENDING

    def _add_deps(self, task: Task, new_deps: Set[str]) -> None:
        for dep in new_deps:
            if dep == task.tid:
                raise ValueError(f"Task {task.tid!r} cannot depend on itself")
            if dep not in self._tasks:
                raise TaskNotFoundError(dep)
            self._watchers.setdefault(dep, [])
            if task.tid not in self._watchers[dep]:
                self._watchers[dep].append(task.tid)
            task.deps.add(dep)

    def _detach_deps(self, task: Task, old_deps: Set[str]) -> None:
        for dep in old_deps:
            children = self._watchers.get(dep)
            if children and task.tid in children:
                children.remove(task.tid)
            task.deps.discard(dep)

    # ------------------------------------------------------------------ #
    # timers (best-effort, decorative)
    # ------------------------------------------------------------------ #
    def arm_timer(self) -> None:
        """Best-effort: sleep until ``earliest_run_time`` before the next poll."""
        with self._timer_lock:
            self._disarm_timer_locked()
            run_at = self.earliest_run_time()
            if run_at is None:
                return
            delay = run_at - time.time()
            if delay <= 0:
                return
            self._timer = threading.Timer(delay, self._on_timer)
            self._timer.daemon = True
            self._timer.start()

    def disarm_timer(self) -> None:
        with self._timer_lock:
            self._disarm_timer_locked()

    def _disarm_timer_locked(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _on_timer(self) -> None:
        with self._timer_lock:
            self._timer = None

    # ------------------------------------------------------------------ #
    # queries / diagnostics
    # ------------------------------------------------------------------ #
    def get_task(self, tid: str) -> Task:
        task = self._tasks.get(tid)
        if task is None:
            raise TaskNotFoundError(tid)
        return task

    def get_task_status(self, tid: str) -> TaskState:
        return self.get_task(tid).state

    def get_task_dependencies(self, tid: str) -> Set[str]:
        return set(self.get_task(tid).deps)

    def get_task_dep_count(self, tid: str) -> int:
        return len(self.get_task(tid).deps)

    def get_children(self, tid: str) -> List[str]:
        return list(self._watchers.get(tid, ()))

    def __len__(self) -> int:
        return len(self._tasks)

    def __contains__(self, tid: str) -> bool:
        return tid in self._tasks

    def iter_tasks(self):
        return iter(self._tasks.values())

    def get_active(self) -> List[str]:
        return [t.tid for t in self._tasks.values() if t.state in LIVE_STATES]

    def dump(self) -> Dict[str, Dict[str, Any]]:
        return {
            tid: {
                "label": t.label,
                "state": t.state.value,
                "priority": t.priority,
                "due": t.due,
                "deps": sorted(t.deps),
                "meta": t.meta,
                "exec_count": t.exec_count,
                "watchers": self.get_children(tid),
                "created": t.created,
                "started": t.started,
                "finished": t.finished,
            }
            for tid, t in self._tasks.items()
        }

    def reset(self) -> None:
        """Clear the entire schedule (for tests/reuse)."""
        with self._timer_lock:
            self._disarm_timer_locked()
        self._tasks.clear()
        self._watchers.clear()
        self._ready_heap.clear()
        self._rseq = 0
