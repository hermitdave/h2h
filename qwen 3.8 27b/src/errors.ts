/**
 * Typed error hierarchy so callers can branch on failure mode
 * without string-matching. All errors carry a stable `name`.
 */
export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed input: bad id, non-finite number, bad dependency format. */
export class InvalidTaskError extends SchedulerError {}

/** No task with the given id. */
export class TaskNotFoundError extends SchedulerError {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task '${taskId}' not found`);
    this.taskId = taskId;
  }
}

/** Id collision on add or within a loadGraph batch. */
export class DuplicateTaskError extends SchedulerError {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task with id '${taskId}' already exists`);
    this.taskId = taskId;
  }
}

/** maxTasks capacity reached. */
export class CapacityExceededError extends SchedulerError {
  readonly limit: number;
  constructor(limit: number) {
    super(`scheduler has reached its maximum task capacity (${limit})`);
    this.limit = limit;
  }
}

/** A dependency edge would create a cycle. `cycle` is the detected path. */
export class CycleError extends SchedulerError {
  /** Closed cycle path: [a, b, c, a] where each node depends on the next. */
  readonly cycle: string[];
  constructor(message: string, cycle: string[] = []) {
    super(message);
    this.cycle = cycle;
  }
}

/** updateTask called with a stale expectedVersion. */
export class StaleVersionError extends SchedulerError {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  constructor(taskId: string, expectedVersion: number, actualVersion: number) {
    super(
      `optimistic-lock conflict on '${taskId}': expected version ${expectedVersion}, actual ${actualVersion}`
    );
    this.taskId = taskId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
