"""
Production-ready in-memory task scheduler.

Features:
- 1M+ tasks
- priorities + execution timestamps
- dependency tracking with cycle detection
- dynamic updates
- efficient next-task retrieval
- thread-safe
"""

from __future__ import annotations

import heapq
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, Set, Optional, Tuple


class SchedulerError(Exception):
    pass


class CycleError(SchedulerError):
    pass


@dataclass
class Task:
    id: str
    scheduled_time: float
    priority: int = 0
    state: str = "pending"  # pending|ready|running|done|cancelled
    data: Any = None
    version: int = 0


class TaskScheduler:
    def __init__(self):
        self._lock = threading.RLock()
        self._tasks: Dict[str, Task] = {}
        self._dependencies: Dict[str, Set[str]] = {}
        self._dependents: Dict[str, Set[str]] = {}
        self._indegree: Dict[str, int] = {}
        # heap entries: (scheduled_time, priority, version, id)
        self._heap: list[Tuple[float, int, int, str]] = []

    # ---------- Public API ----------

    def add_task(self, task_id: str, scheduled_time: float, priority: int = 0, data: Any = None, depends_on: Optional[list[str]] = None):
        with self._lock:
            if task_id in self._tasks:
                raise SchedulerError(f"Task {task_id} exists")
            task = Task(id=task_id, scheduled_time=scheduled_time, priority=priority, data=data, state="pending")
            self._tasks[task_id] = task
            self._dependencies[task_id] = set()
            self._dependents[task_id] = set()
            self._indegree[task_id] = 0

            if depends_on:
                for dep in depends_on:
                    self._add_dependency_internal(task_id, dep)

            self._push_task(task)

    def add_dependency(self, task_id: str, depends_on_id: str):
        with self._lock:
            self._ensure_exists(task_id, depends_on_id)
            if depends_on_id in self._dependencies.get(task_id, set()):
                return
            self._add_dependency_internal(task_id, depends_on_id)

    def update_task(self, task_id: str, scheduled_time: Optional[float] = None, priority: Optional[int] = None):
        with self._lock:
            task = self._get_task(task_id)
            changed = False
            if scheduled_time is not None and scheduled_time != task.scheduled_time:
                task.scheduled_time = scheduled_time
                changed = True
            if priority is not None and priority != task.priority:
                task.priority = priority
                changed = True
            if changed:
                task.version += 1
                if task.state in ("pending", "ready"):
                    self._push_task(task)

    def complete_task(self, task_id: str):
        with self._lock:
            task = self._get_task(task_id)
            if task.state in ("done", "cancelled"):
                return
            task.state = "done"
            for child_id in list(self._dependents.get(task_id, [])):
                self._indegree[child_id] -= 1
                if self._indegree[child_id] == 0:
                    child = self._tasks[child_id]
                    if child.state == "pending":
                        child.state = "ready"
                        self._push_task(child)

    def get_next_task(self, now: Optional[float] = None) -> Optional[Task]:
        with self._lock:
            now = now if now is not None else 0.0
            while self._heap:
                t, p, v, tid = self._heap[0]
                task = self._tasks.get(tid)
                if not task:
                    heapq.heappop(self._heap)
                    continue
                if task.version != v:
                    heapq.heappop(self._heap)
                    continue
                if task.state not in ("pending", "ready"):
                    heapq.heappop(self._heap)
                    continue
                if self._indegree.get(tid, 0) > 0:
                    heapq.heappop(self._heap)
                    continue
                if t > now:
                    # earliest task not ready yet
                    break
                # valid entry
                heapq.heappop(self._heap)
                if task.state == "pending":
                    task.state = "ready"
                task.state = "running"
                return task
            return None

    def cancel_task(self, task_id: str):
        with self._lock:
            task = self._get_task(task_id)
            task.state = "cancelled"
            task.version += 1

    # ---------- Internals ----------

    def _ensure_exists(self, *ids):
        for i in ids:
            if i not in self._tasks:
                raise SchedulerError(f"Task {i} not found")

    def _get_task(self, task_id: str) -> Task:
        task = self._tasks.get(task_id)
        if not task:
            raise SchedulerError(f"Task {task_id} not found")
        return task

    def _add_dependency_internal(self, task_id: str, depends_on_id: str):
        if self._has_path(task_id, depends_on_id):
            raise CycleError(f"Adding dependency {depends_on_id} -> {task_id} creates cycle")
        self._dependencies[task_id].add(depends_on_id)
        self._dependents.setdefault(depends_on_id, set()).add(task_id)
        self._indegree[task_id] += 1
        # task becomes pending if it was ready
        task = self._tasks[task_id]
        if task.state == "ready":
            task.state = "pending"
        task.version += 1

    def _has_path(self, start: str, target: str) -> bool:
        if start == target:
            return True
        stack = [start]
        visited = set()
        while stack:
            cur = stack.pop()
            if cur in visited:
                continue
            visited.add(cur)
            for child in self._dependents.get(cur, []):
                if child == target:
                    return True
                stack.append(child)
        return False

    def _push_task(self, task: Task):
        if self._indegree.get(task.id, 0) > 0:
            task.state = "pending"
            return
        task.state = "ready"
        entry = (task.scheduled_time, task.priority, task.version, task.id)
        heapq.heappush(self._heap, entry)

    # ---------- Introspection ----------

    def task_count(self) -> int:
        return len(self._tasks)

    def pending_count(self) -> int:
        return sum(1 for t in self._tasks.values() if t.state == "pending")

    def ready_count(self) -> int:
        return sum(1 for t in self._tasks.values() if t.state == "ready")
