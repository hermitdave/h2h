"""Exception hierarchy for the scheduler."""

from __future__ import annotations


class SchedulerError(Exception):
    """Base class for all scheduler errors."""


class TaskNotFoundError(SchedulerError):
    """Raised when an operation references a non-existent task id.

    Carries the offending id so callers can reuse it in error messages.
    """

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Task not found: {task_id!r}")


class AlreadyExistsError(SchedulerError):
    """Raised when an id is already in use and uniqueness is enforced."""

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Task already exists: {task_id!r}")
