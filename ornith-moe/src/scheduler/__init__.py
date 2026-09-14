"""Production-grade in-memory priority task scheduler.

Public surface:

- ``Task`` / ``TaskInput`` -- task definition dataclasses.
- ``TaskState`` -- enum of lifecycle states.
- ``Priority`` -- the 11-level rounded priority enum.
- ``TaskNotFoundError`` / ``AlreadyExistsError`` -- error hierarchy.
- ``Scheduler`` -- the core scheduler.
"""

from .errors import TaskNotFoundError, AlreadyExistsError
from .task import Task, TaskInput, TaskState, Priority, LIVE_STATES
from .scheduler import Scheduler

__all__ = [
    "Task",
    "TaskInput",
    "TaskState",
    "Priority",
    "LIVE_STATES",
    "Scheduler",
    "TaskNotFoundError",
    "AlreadyExistsError",
]
