/**
 * Scheduler error hierarchy. Every error carries a stable `code` so
 * callers can classify failures programmatically instead of parsing
 * messages.
 */

/** Base class for scheduler errors. */
export class SchedulerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
  }
}

/** The referenced task id does not exist in the scheduler. */
export class UnknownTaskError extends SchedulerError {
  constructor(id: string) {
    super('UNKNOWN_TASK', `Unknown task id: "${id}"`);
    this.name = 'UnknownTaskError';
  }
}

/** A task with this id is already registered. */
export class DuplicateTaskError extends SchedulerError {
  constructor(id: string) {
    super('DUPLICATE_TASK', `Task id already registered: "${id}"`);
    this.name = 'DuplicateTaskError';
  }
}

/** Structurally invalid task input (empty id, non-finite numbers). */
export class InvalidTaskError extends SchedulerError {
  constructor(detail: string) {
    super('INVALID_TASK', `Invalid task input: ${detail}`);
    this.name = 'InvalidTaskError';
  }
}

/** A dependency reference does not name an existing task (strict mode). */
export class InvalidDependencyError extends SchedulerError {
  constructor(depId: string) {
    super(
      'INVALID_DEPENDENCY',
      `Dependency "${depId}" does not reference an existing task`,
    );
    this.name = 'InvalidDependencyError';
  }
}

/** Adding or updating an edge would create a dependency cycle. */
export class CycleError extends SchedulerError {
  /** Witness path proving the cycle (edge target … edge source). */
  readonly cycle: string[];

  constructor(cycle: string[], message: string) {
    super('CYCLE_DETECTED', message);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

/** The scheduler is at its configured maxTasks capacity. */
export class CapacityExceededError extends SchedulerError {
  constructor(limit: number, current: number) {
    super(
      'CAPACITY_EXCEEDED',
      `Task capacity limit reached: ${current}/${limit} tasks`,
    );
    this.name = 'CapacityExceededError';
  }
}

/** The operation targets a task already in a terminal status. */
export class TerminalTaskError extends SchedulerError {
  constructor(id: string, status: string, operation: string) {
    super(
      'TERMINAL_TASK',
      `Cannot ${operation} task "${id}": already in terminal status ${status}`,
    );
    this.name = 'TerminalTaskError';
  }
}

/** The operation requires a status the task does not have. */
export class InvalidStatusError extends SchedulerError {
  constructor(id: string, status: string, operation: string) {
    super(
      'INVALID_STATUS',
      `Cannot ${operation} task "${id}": requires a non-blocked status, found ${status}`,
    );
    this.name = 'InvalidStatusError';
  }
}

/** The scheduler has been disposed and no longer accepts operations. */
export class DisposedSchedulerError extends SchedulerError {
  constructor() {
    super('DISPOSED_SCHEDULER', 'Scheduler has been disposed');
    this.name = 'DisposedSchedulerError';
  }
}
