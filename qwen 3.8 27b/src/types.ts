/**
 * Lifecycle states for a task.
 *
 * State machine:
 *
 *   PENDING ──(all deps COMPLETED)──▶ READY ──(claimed)──▶ RUNNING
 *      ▲                                 │                     │
 *      │                                 │ update changes deps │
 *      │                                 │ (deps no longer met)│
 *      └─────────────────────────────────┘                     │
 *   PENDING ──(operator)──▶ CANCELLED ◀──(abandon)─────────────┘
 *   PENDING/READY/RUNNING ──(error)──▶ FAILED
 *   PENDING/READY/RUNNING ──(operator)──▶ COMPLETED
 *
 * Terminal states (COMPLETED, FAILED, CANCELLED) are immutable.
 *
 * "Executable" is deliberately NOT a stored status: it is a derived
 * predicate (status === READY ∧ executeTime ≤ clock ∧ deps satisfied).
 * Storing it would require a time-driven state flip for every task,
 * which is churn without information.
 */
export enum TaskStatus {
  /** Waiting on one or more dependencies that are not yet COMPLETED. */
  PENDING = 'PENDING',
  /** All dependencies COMPLETED. May or may not be due yet. */
  READY = 'READY',
  /** Claimed by a worker; execution in flight. */
  RUNNING = 'RUNNING',
  /** Finished successfully. Terminal. */
  COMPLETED = 'COMPLETED',
  /** Execution failed. Terminal. Dependents remain blocked (fail-safe). */
  FAILED = 'FAILED',
  /** Cancelled by an operator. Terminal. Dependents remain blocked. */
  CANCELLED = 'CANCELLED',
}

export type TerminalStatus =
  | TaskStatus.COMPLETED
  | TaskStatus.FAILED
  | TaskStatus.CANCELLED;

/**
 * A scheduled task. Mutable record owned by the scheduler: callers must
 * treat fields as read-only. The scheduler maintains all invariants.
 */
export interface Task {
  readonly id: string;
  /** Opaque work descriptor. Stored by reference; not validated. */
  payload: unknown;
  /** Higher value = more urgent. Must be finite. Default 0. */
  priority: number;
  /** Epoch ms at which the task is allowed to execute. Default = clock at add. */
  executeTime: number;
  /** Deduplicated dependency ids. All must exist at add/update time. */
  dependencies: string[];
  status: TaskStatus;
  /** Number of dependencies not yet COMPLETED (incl. dangling). Maintained incrementally; recomputed on reconcile. */
  unmetDependencies: number;
  /** Revision counter, bumped by updateTask. Use for optimistic concurrency. */
  version: number;
  /** Epoch ms of creation (scheduler clock). */
  createdAt: number;
  /** Epoch ms of last mutation (scheduler clock). */
  updatedAt: number;
  /** Monotonic creation sequence; final deterministic tie-breaker. */
  sequence: number;
  /** Populated by failTask. */
  failureReason?: unknown;
}

export interface AddTaskInput {
  id: string;
  payload?: unknown;
  priority?: number;
  executeTime?: number;
  dependencies?: readonly string[];
}

/**
 * Partial update. `dependencies === null` clears the list.
 * Providing `dependencies` re-validates existence and cycle-freedom of every
 * newly added edge.
 */
export interface UpdateTaskInput {
  payload?: unknown;
  priority?: number;
  executeTime?: number;
  dependencies?: readonly string[] | null;
}

export interface SchedulerOptions {
  /** Initial scheduler clock (epoch ms). Default Date.now(). Monotonic afterwards. */
  now?: number;
  /** Hard capacity on live tasks. 0 = unbounded. */
  maxTasks?: number;
  /** Fired synchronously after a task is claimed (status RUNNING). */
  onTaskClaimed?: (task: Task) => void;
  /** Fired synchronously after a task is completed, before dependents unblock. */
  onTaskCompleted?: (task: Task) => void;
  /** Fired synchronously after a task fails. */
  onTaskFailed?: (task: Task) => void;
  /** Fired synchronously after a task is cancelled. */
  onTaskCancelled?: (task: Task) => void;
}

/** O(1) snapshot of scheduler health. Safe to call in hot paths. */
export interface SchedulerMetrics {
  total: number;
  byStatus: Record<TaskStatus, number>;
  dueHeapSize: number;
  futureHeapSize: number;
  /** Sum of all dependency edges (depsOf sizes). */
  totalEdges: number;
  clock: number;
  added: number;
  claimed: number;
  completed: number;
  failed: number;
  cancelled: number;
  deleted: number;
  /** future → due promotions performed. */
  promotions: number;
  /** Stale heap entries discarded (canceled/failed/dangling while queued). */
  staleDiscards: number;
  /** Backward `now` values ignored (clock is monotonic). */
  clockRegressionsIgnored: number;
}

/** Diagnostic entry for a task that can never currently execute. */
export interface BlockedTask {
  task: Task;
  /** Dependency ids that exist but are not COMPLETED. */
  missing: string[];
  /** Dependency ids that no longer exist in the scheduler. */
  dangling: string[];
}

/** Synchronous or asynchronous work function. */
export type TaskExecutor<T = unknown> = (task: Task) => T | Promise<T>;
