/**
 * Agnes Flash task scheduler — public type surface.
 */

/** Lifecycle states for a scheduled task. */
export type TaskStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Statuses from which a task cannot transition again without an
 * explicit resetTask call.
 */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

/** A task as tracked by the scheduler. */
export interface Task {
  id: string;
  name?: string;
  status: TaskStatus;
  /** Higher value = more urgent. Primary ordering key for the heap. */
  priority: number;
  /** Earliest epoch-ms at which the task may execute. Secondary ordering key. */
  executeTime: number;
  /** Ids of the tasks that must complete before this task may run. */
  dependencies: Set<string>;
  /** Epoch-ms of creation. Tertiary ordering key (tie-break). */
  createdAt: number;
  /** Epoch-ms of the most recent start. */
  startedAt?: number;
  /** Epoch-ms of the most recent finish. */
  finishedAt?: number;
  /** Human-readable explanation when status is FAILED or CANCELLED. */
  failureReason?: string;
  /** Execution attempts so far (increments on every RUNNING transition). */
  attempts: number;
  /** Arbitrary user data carried by the task. */
  payload?: unknown;
  /** Arbitrary structured metadata. */
  metadata?: Record<string, unknown>;
}

/** Input for registering a new task. All fields after id are optional. */
export interface AddTaskInput {
  id: string;
  name?: string;
  /** Omitted → 0 (neutral urgency). */
  priority?: number;
  /** Omitted → now (immediately executable). */
  executeTime?: number;
  dependencies?: string[];
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

/** Partial update applied to an existing task. */
export interface TaskUpdates {
  name?: string;
  priority?: number;
  executeTime?: number;
  /** When present, fully replaces the task's dependency set. */
  dependencies?: string[];
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

/** User-supplied execution function, invoked by executeNextTask. */
export type RunnerFn = (task: Task) => Promise<void>;

/** Result of executeNextTask. */
export type NextTaskResult =
  | {
      kind: 'executed';
      task: Task;
      startedAt: number;
      finishedAt: number;
      durationMs: number;
      error?: string;
    }
  | { kind: 'running'; task: Task; startedAt: number }
  | { kind: 'none' };

/**
 * Optional lifecycle hooks. All advisory: a failing hook is recorded in
 * metrics and never rolls back a committed state transition.
 */
export interface SchedulerHooks {
  onTaskAdded?: (task: Task) => void | Promise<void>;
  onTaskUpdated?: (task: Task, changes: string[]) => void | Promise<void>;
  onTaskDeleted?: (task: Task) => void | Promise<void>;
  onTaskStarted?: (task: Task) => void | Promise<void>;
  onTaskCompleted?: (task: Task) => void | Promise<void>;
  onTaskFailed?: (task: Task, reason: string) => void | Promise<void>;
  onTaskCancelled?: (task: Task, reason: string) => void | Promise<void>;
  onTaskUnblocked?: (task: Task) => void | Promise<void>;
  onTaskReset?: (task: Task) => void | Promise<void>;
}

/**
 * Point-in-time snapshot of scheduler health, assembled in O(1) from
 * incremental counters maintained on every state transition.
 */
export interface TaskMetrics {
  totalTasks: number;
  byStatus: Record<TaskStatus, number>;
  dependencyEdges: number;
  heapSize: number;
  executed: number;
  unblocked: number;
  propagatedFailures: number;
  upserts: number;
  deletions: number;
  resets: number;
  cycleAudits: number;
  hookErrors: number;
  lastError?: string;
}

/** Report returned by hasCycle(). */
export interface CycleReport {
  hasCycle: boolean;
  /**
   * Witness cycle when found: the ids forming the loop, with the first
   * id repeated at the end to close the loop.
   */
  cycle?: string[];
}

/** Scheduler construction options. */
export interface SchedulerOptions {
  /** Upper bound on live tasks; addTask rejects beyond this. Default: unbounded. */
  maxTasks?: number;
  /**
   * Allow dependencies on tasks that do not exist yet (forward
   * references); satisfied automatically once the referenced task is
   * registered. Default: false (strict validation).
   */
  allowForwardRefs?: boolean;
  hooks?: SchedulerHooks;
  runner?: RunnerFn;
  /** Clock source. Inject a fake clock in tests for deterministic time. */
  nowProvider?: () => number;
}

/**
 * Public contract implemented by TaskScheduler.
 *
 * Mutating methods are asynchronous: every mutation is serialized
 * through an internal promise queue, so concurrent callers never
 * observe interleaved state. Read-only methods are synchronous —
 * they mutate nothing, so they need no serialization. The one
 * exception is hasCycle, whose full-graph audit is expensive enough
 * that it is serialized so a long scan never blocks the event loop.
 */
export interface ITaskScheduler {
  addTask(input: AddTaskInput): Promise<Task>;
  updateTask(id: string, updates: TaskUpdates): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  completeTask(id: string, now?: number): Promise<Task>;
  failTask(id: string, reason?: string): Promise<Task>;
  cancelTask(id: string, reason?: string): Promise<Task>;
  resetTask(id: string): Promise<Task>;
  executeNextTask(now?: number): Promise<NextTaskResult>;
  /** Read-only: all tasks that are executable at `now`. */
  getExecutableTasks(now?: number): Task[];
  /** Read-only: true when the edge taskId → depId would form a cycle. */
  wouldCreateCycle(taskId: string, depId: string): boolean;
  /** Full-graph cycle audit, O(n + e) with early exit. Asynchronous. */
  hasCycle(): Promise<CycleReport>;
  /** Read-only, O(1): assembled from incremental counters. */
  getMetrics(): TaskMetrics;
  /** Read-only, O(n): reconciles counters against live state. */
  auditMetrics(): { drift: string[] };
  /** Read-only lookup by id. */
  getTask(id: string): Task | undefined;
  clear(): Promise<void>;
  dispose(): Promise<void>;
}
