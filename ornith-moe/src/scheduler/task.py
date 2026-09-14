"""Task model: enums, input DTO, and the internal live representation.

The public API accepts a light-weight, user-facing ``TaskInput`` (which a user
can build by hand or serialize from JSON) and the scheduler converts it into the
internal :class:`Task` object, which carries all of the bookkeeping state the
scheduler needs to maintain its invariants.

Ordering note
-------------
Tasks are ordered primarily by ``due`` (soonest first), then by descending
``priority`` (higher value == more urgent), then by a monotonic insertion
sequence (so the total order is strict and non-ascending -- a stable
top-of-heap is possible without ever comparing task objects). ``due`` accepts
epoch seconds (``int``/``float``) or a :class:`datetime.timedelta`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum, StrEnum
from datetime import timedelta
from typing import Any, Dict, List, Optional, Set, Tuple


class Priority(int, Enum):
    """A rounded task priority.

    Exactly 11 distinct integer levels spanning ``-5`` (lowest) to ``5``
    (highest). The value is interpreted as "higher number == more urgent".

    The value is stored as a plain ``int`` internally so that ordering is cheap
    arithmetic; callers may also pass an arbitrary ``int`` in ``[-5, 5]`` to
    :meth:`Scheduler.add_task`.
    """

    LOWEST = -5
    LOWER = -4
    LOW = -3
    SUBNORMAL = -2
    LOWER_NORMAL = -1
    NORMAL = 0
    UPPER_NORMAL = 1
    HIGH = 2
    HIGHER = 3
    HIGHEST = 4
    URGENT = 5  # explicit alias for the most urgent level

    #: inclusive valid range; validation uses ``_MIN <= value <= _MAX``.
    _MIN: int = -5
    _MAX: int = 5


class TaskState(str, Enum):
    """Lifecycle of a task inside the scheduler."""

    PENDING = "pending"     # registered and executable; held in the ready heap
    RUNNING = "running"     # handed out by next_task(); awaiting done/fail
    WAITING = "waiting"     # blocked on one or more live dependencies
    DONE = "done"           # completed via done_task()
    CANCELLED = "cancelled" # removed by cancel_task()
    DEPRECATED = "deprecated"  # superseded (will not be rescheduled)
    FAILED = "failed"       # failed via fail_task()

    #: The live states are collected in :data:`LIVE_STATES` (a module constant).
    #: A task is "gone" from the active graph when its state is in
    #: :data:`_GONE_STATES` (retaining a tombstone so in-flight child-wakeups
    #: resolve cleanly).


#: The live :class:`TaskState` members (kept as a module constant so it is not
#: itself an enum member). ``task.state in LIVE_STATES`` tests liveness.
LIVE_STATES: Tuple[TaskState, ...] = (
    TaskState.PENDING,
    TaskState.RUNNING,
    TaskState.WAITING,
)


#: states in which the task is "gone" from the active graph but retains a
#: tombstone so in-flight child-wakeups resolve cleanly.
_GONE_STATES: Tuple[TaskState, ...] = (
    TaskState.CANCELLED,
    TaskState.DONE,
    TaskState.DEPRECATED,
    TaskState.FAILED,
)


@dataclass(frozen=True)
class TaskInput:
    """User-facing, serialisable task description passed to :meth:`Scheduler.add_task`.

    ``priority`` and ``due`` accept either their natural type (an
    :class:`Priority` / a time value) or ``None`` (meaning "use the default").
    """

    label: str
    priority: Optional[Any] = None
    due: Any = None
    depends_on: Tuple[str, ...] = ()
    meta: Dict[str, Any] = field(default_factory=dict)

    def validated_due(self) -> Optional[float]:
        """Return a normalised due time (float epoch seconds) or ``None``.

        Accepts ``None`` (leave to the scheduler default), a numeric epoch, or
        a :class:`datetime.timedelta` (resolved against ``now`` at add-time).
        """
        if self.due is None:
            return None
        if isinstance(self.due, timedelta):
            return time.time() + self.due.total_seconds()
        if isinstance(self.due, (int, float)) and not isinstance(self.due, bool):
            return float(self.due)
        raise TypeError(
            f"due must be None, a number (epoch seconds), or timedelta, "
            f"got {type(self.due).__name__}"
        )


def norm_priority(p: Any) -> int:
    """Coerce a ``Priority`` / int into a plain ``int`` within the valid range.

    Raises :class:`TypeError` for non-integer values and :class:`ValueError`
    for integers outside ``[-5, 5]`` (honouring the 11-level validation).
    """
    if isinstance(p, Priority):
        return int(p.value)
    if isinstance(p, int) and not isinstance(p, bool):
        if Priority._MIN <= p <= Priority._MAX:
            return p
        raise ValueError(f"priority out of range [{Priority._MIN}, {Priority._MAX}]: {p!r}")
    raise TypeError(f"priority must be a Priority or int, got {type(p).__name__}")


@dataclass(eq=False)
class Task:
    """Internal, mutable task representation tracked by the scheduler.

    Extends :class:`TaskInput` with all of the scheduler bookkeeping. Users
    should treat this as opaque; inspect it read-only.

    Equality is defined by :attr:`tid` (and, for convenience, by a matching
    string); this lets ``next_task()`` return an id that compares equal to the
    ``Task`` returned by :meth:`Scheduler.get_task`.
    """

    tid: str
    label: str
    priority: int
    due: float
    depends_on: Tuple[str, ...]
    meta: Dict[str, Any]

    # lifecycle bookkeeping
    state: TaskState = TaskState.PENDING
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)
    started: Optional[float] = None
    finished: Optional[float] = None
    exec_count: int = 0

    # dependency pointers
    deps: Set[str] = field(default_factory=set)   # remaining *unresolved* deps
    watchers: List[str] = field(default_factory=list)  # dependents (reverse edges)

    # rseq of this task's *current valid* ready-heap entry; 0 if not resident.
    # Used to detect and lazily discard stale entries at the heap top.
    heap_mark: int = 0

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Task):
            return self.tid == other.tid
        if isinstance(other, str):
            return self.tid == other
        return NotImplemented

    def __hash__(self) -> int:
        return hash(self.tid)
