import { AsyncLocalStorage } from 'node:async_hooks';
import { BinaryHeap } from './binary-heap';
import type {
  AddTaskInput,
  CycleReport,
  NextTaskResult,
  RunnerFn,
  SchedulerHooks,
  SchedulerOptions,
  Task,
  TaskMetrics,
  TaskStatus,
  TaskUpdates,
} from './types';
import { TERMINAL_STATUSES } from './types';
import {
  CapacityExceededError,
  CycleError,
  DisposedSchedulerError,
  DuplicateTaskError,
  InvalidDependencyError,
  InvalidStatusError,
  InvalidTaskError,
  TerminalTaskError,
  UnknownTaskError,
} from './errors';

type AnyHook = (...args: unknown[]) => void | Promise<unknown>;

interface Counters {
  byStatus: Record<TaskStatus, number>;
  edges: number;
  executed: number;
  unblocked: number;
  propagatedFailures: number;
  upserts: number;
  deletions: number;
  resets: number;
  cycleAudits: number;
  hookErrors: number;
}

interface DfsFrame {
  node: string;
  deps: string[];
  depIdx: number;
}

/** Identity of the currently-executing operation; the reentrancy marker. */
interface WriterToken {
  readonly opId: symbol;
}

/**
 * In-memory task scheduler.
 *
 * Core structures (see ARCHITECTURE.md for the full rationale):
 *  - `tasks`      Map<id, Task>          O(1) lookup / mutation / deletion
 *  - `heap`        BinaryHeap<string>     max-heap of READY task ids
 *  - `dependents`  Map<depId, Set<id>>   reverse edges for unblock/propagation
 *
 * Forward dependency edges live on `task.dependencies`; the dependents
 * map is the only scheduler-owned edge structure, so every edge has
 * exactly one owner on each side, and _addDependent/_removeDependent
 * keep the two sides in sync.
 *
 * Every mutating public method is serialized through an internal
 * single-writer queue (`_serialized`): independent submissions run
 * strictly in submission order, so concurrent callers never observe
 * interleaved state. Submissions originating from within an executing
 * operation (e.g. a runner that enqueues follow-up tasks) are detected
 * via an AsyncLocalStorage writer token and run immediately instead of
 * queueing behind the operation that awaits them — queueing would be a
 * circular wait. Settled operations are dequeued, so retained memory
 * tracks the in-flight backlog rather than the scheduler's entire
 * history. Read-only methods are synchronous (they mutate nothing);
 * the expensive full-graph audit (hasCycle) is serialized so a long
 * scan never blocks the event loop.
 *
 * State machine:
 *   PENDING --deps met--> READY --executeTime<=now--> RUNNING
 *   PENDING/READY --dep failed/cancelled (propagation)--> FAILED
 *   RUNNING --success--> COMPLETED          RUNNING --failure--> FAILED
 *   any live --cancelTask--> CANCELLED
 *   terminal --resetTask--> PENDING/READY
 */
export class TaskScheduler {
  // ── Core structures ────────────────────────────────────────────────
  private readonly tasks = new Map<string, Task>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly heap: BinaryHeap<string>;

  // ── Configuration ──────────────────────────────────────────────────
  private readonly hooks: SchedulerHooks;
  private readonly runner: RunnerFn | undefined;
  private readonly nowProvider: () => number;
  private readonly maxTasks: number;
  private readonly allowForwardRefs: boolean;

  // ── Bookkeeping ────────────────────────────────────────────────────
  private readonly counters: Counters;
  private lastError: string | undefined;
  private _disposed = false;
  // ── Serialization ──────────────────────────────────────────────────
  private readonly storage = new AsyncLocalStorage<WriterToken>();
  private _current: symbol | undefined = undefined;
  private _head: Promise<unknown> = Promise.resolve();
  private readonly _pending: Promise<unknown>[] = [];

  constructor(options: SchedulerOptions = {}) {
    this.hooks = options.hooks ?? {};
    this.runner = options.runner;
    this.nowProvider = options.nowProvider ?? (() => Date.now());
    this.maxTasks = options.maxTasks ?? Number.POSITIVE_INFINITY;
    this.allowForwardRefs = options.allowForwardRefs ?? false;
    this.counters = {
      byStatus: { PENDING: 0, READY: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
      edges: 0,
      executed: 0,
      unblocked: 0,
      propagatedFailures: 0,
      upserts: 0,
      deletions: 0,
      resets: 0,
      cycleAudits: 0,
      hookErrors: 0,
    };
    this.heap = new BinaryHeap<string>(this.compareIds.bind(this));
  }

  // ── Public API: mutations (serialized through the internal queue) ──

  addTask(input: AddTaskInput): Promise<Task> {
    return this._serialized(() => this._addTask(input));
  }

  updateTask(id: string, updates: TaskUpdates): Promise<Task> {
    return this._serialized(() => this._updateTask(id, updates));
  }

  deleteTask(id: string): Promise<void> {
    return this._serialized(() => this._deleteTask(id));
  }

  completeTask(id: string, now?: number): Promise<Task> {
    return this._serialized(() => this._completeTask(id, now));
  }

  failTask(id: string, reason?: string): Promise<Task> {
    return this._serialized(() => this._failTask(id, reason));
  }

  cancelTask(id: string, reason?: string): Promise<Task> {
    return this._serialized(() => this._cancelTask(id, reason));
  }

  resetTask(id: string): Promise<Task> {
    return this._serialized(() => this._resetTask(id));
  }

  executeNextTask(now?: number): Promise<NextTaskResult> {
    return this._serialized(() => this._executeNextTask(now ?? this._now()));
  }

  clear(): Promise<void> {
    return this._serialized(async () => {
      this._assertUsable();
      this._clearInternal();
    });
  }

  dispose(): Promise<void> {
    return this._serialized(async () => {
      this._clearInternal();
      this._disposed = true;
      // After dispose, the queue tail is a rejecting promise: operations
      // submitted after the dispose reject without running, while
      // in-flight operations submitted before it still complete.
      this._head = Promise.reject(new DisposedSchedulerError());
    });
  }

  // ── Public API: reads (synchronous — they mutate nothing) ──────────

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getExecutableTasks(now?: number): Task[] {
    const t = now ?? this._now();
    const out: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'READY' && this._depsSatisfied(task) && task.executeTime <= t) {
        out.push(task);
      }
    }
    return out;
  }

  wouldCreateCycle(taskId: string, depId: string): boolean {
    return this._wouldCreateCycle(taskId, depId);
  }

  hasCycle(): Promise<CycleReport> {
    return this._serialized(async () => {
      this._assertUsable();
      this.counters.cycleAudits++;
      return this._findCycle();
    });
  }

  getMetrics(): TaskMetrics {
    const metrics: TaskMetrics = {
      totalTasks: this.tasks.size,
      byStatus: { ...this.counters.byStatus },
      dependencyEdges: this.counters.edges,
      heapSize: this.heap.size,
      executed: this.counters.executed,
      unblocked: this.counters.unblocked,
      propagatedFailures: this.counters.propagatedFailures,
      upserts: this.counters.upserts,
      deletions: this.counters.deletions,
      resets: this.counters.resets,
      cycleAudits: this.counters.cycleAudits,
      hookErrors: this.counters.hookErrors,
    };
    if (this.lastError !== undefined) metrics.lastError = this.lastError;
    return metrics;
  }

  /** Reconciles incremental counters against live state; reports drift. */
  auditMetrics(): { drift: string[] } {
    const actual: Record<TaskStatus, number> = {
      PENDING: 0,
      READY: 0,
      RUNNING: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLED: 0,
    };
    let edges = 0;
    for (const task of this.tasks.values()) {
      actual[task.status] += 1;
      edges += task.dependencies.size;
    }
    const drift: string[] = [];
    for (const status of ['PENDING', 'READY', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      if (actual[status] !== this.counters.byStatus[status]) {
        drift.push(`byStatus.${status}: counter=${this.counters.byStatus[status]} actual=${actual[status]}`);
      }
    }
    if (edges !== this.counters.edges) {
      drift.push(`dependencyEdges: counter=${this.counters.edges} actual=${edges}`);
    }
    return { drift };
  }

  // ── Serialized mutation bodies ─────────────────────────────────────

  private async _addTask(input: AddTaskInput): Promise<Task> {
    this._assertUsable();
    const id = input.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidTaskError('id must be a non-empty string');
    }
    if (this.tasks.has(id)) throw new DuplicateTaskError(id);
    if (this.tasks.size >= this.maxTasks) {
      throw new CapacityExceededError(this.maxTasks, this.tasks.size);
    }

    const now = this._now();
    const priority = input.priority ?? 0;
    const executeTime = input.executeTime ?? now;
    if (!Number.isFinite(priority)) {
      throw new InvalidTaskError(`priority must be a finite number (got ${String(priority)})`);
    }
    if (!Number.isFinite(executeTime)) {
      throw new InvalidTaskError(`executeTime must be a finite number (got ${String(executeTime)})`);
    }

    // Phase 1 — validate every dependency before registering any of
    // them, so a rejected input never leaves partial edge state behind.
    const depSet = this._validateDeps(id, input.dependencies ?? []);

    const task: Task = {
      id,
      ...(input.name !== undefined ? { name: input.name } : {}),
      status: 'PENDING' as TaskStatus,
      priority,
      executeTime,
      dependencies: depSet,
      createdAt: now,
      attempts: 0,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };

    // Phase 2 — register reverse edges, then insert the task.
    for (const depId of depSet) this._addDependent(depId, id);
    this.tasks.set(id, task);
    this.counters.upserts++;

    // Phase 3 — reconcile status against the live graph, then apply the
    // matching side effects:
    //   dep already FAILED/CANCELLED, or a dangling forward reference
    //     → created FAILED, and the failure propagates to this task's
    //       would-be dependents;
    //   all deps COMPLETED, or no deps at all → READY (heap entry);
    //   otherwise → stays PENDING (blocked on unfinished deps).
    const failedDep = this._findFailedDep(task);
    if (failedDep !== undefined) {
      task.status = 'FAILED';
      task.failureReason = `upstream_failed:${failedDep}`;
      task.finishedAt = now;
      const marked = await this._propagateFailure(id, task.failureReason);
      this.counters.propagatedFailures += marked;
      this._countStatusChange(undefined, task.status);
      await this._fireHook('onTaskFailed', task, task.failureReason);
    } else if (depSet.size === 0 || this._depsSatisfied(task)) {
      task.status = 'READY';
      this._countStatusChange(undefined, task.status);
      this.heap.push(id);
      if (depSet.size > 0) {
        this.counters.unblocked++;
        await this._fireHook('onTaskUnblocked', task);
      }
      await this._fireHook('onTaskAdded', task);
    } else {
      this._countStatusChange(undefined, task.status);
      await this._fireHook('onTaskAdded', task);
    }
    return task;
  }

  private async _updateTask(id: string, updates: TaskUpdates): Promise<Task> {
    this._assertUsable();
    const task = this.tasks.get(id);
    if (!task) throw new UnknownTaskError(id);
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new TerminalTaskError(id, task.status, 'update');
    }
    if (task.status === 'RUNNING' && updates.dependencies !== undefined) {
      throw new InvalidStatusError(id, task.status, 'update dependencies of a running task');
    }

    const oldDeps = new Set(task.dependencies);
    const changes: string[] = [];

    if (updates.name !== undefined) {
      task.name = updates.name;
      changes.push('name');
    }
    if (updates.payload !== undefined) {
      task.payload = updates.payload;
      changes.push('payload');
    }
    if (updates.metadata !== undefined) {
      task.metadata = updates.metadata;
      changes.push('metadata');
    }
    if (updates.priority !== undefined) {
      if (!Number.isFinite(updates.priority)) {
        throw new InvalidTaskError(`priority must be a finite number (got ${String(updates.priority)})`);
      }
      task.priority = updates.priority;
      changes.push('priority');
    }
    if (updates.executeTime !== undefined) {
      if (!Number.isFinite(updates.executeTime)) {
        throw new InvalidTaskError(`executeTime must be a finite number (got ${String(updates.executeTime)})`);
      }
      task.executeTime = updates.executeTime;
      changes.push('executeTime');
    }

    if (updates.dependencies !== undefined) {
      // Validate every new dependency before registering any of them,
      // so a rejected update never leaves partial edge state behind.
      // (Validating against the pre-update graph is exact, not merely
      // conservative: the cycle BFS stops at the target before
      // traversing the target's own edges, so stale old edges cannot
      // create false rejects.)
      const newDeps = this._validateDeps(id, updates.dependencies);
      for (const depId of oldDeps) {
        if (!newDeps.has(depId)) this._removeDependent(depId, id);
      }
      for (const depId of newDeps) {
        if (!oldDeps.has(depId)) this._addDependent(depId, id);
      }
      task.dependencies = newDeps;
      changes.push('dependencies');
    }

    // Reconcile status + heap membership against the new dependency set.
    await this._reconcileStatus(task);

    // Re-seat in the heap when a comparator-relevant field changed and
    // the task remains READY (the heap was ordered on the old values).
    if (
      (changes.includes('priority') || changes.includes('executeTime')) &&
      task.status === 'READY' &&
      this.heap.contains(id)
    ) {
      this.heap.remove(id);
      this.heap.push(id);
    }

    this.counters.upserts++;
    await this._fireHook('onTaskUpdated', task, changes);
    return task;
  }

  private async _deleteTask(id: string): Promise<void> {
    this._assertUsable();
    const task = this.tasks.get(id);
    if (!task) throw new UnknownTaskError(id);

    // Step 1 — propagate failure to all reachable dependents BEFORE
    // touching the graph, so the BFS sees intact edges. Deleting a task
    // means its output will never materialize; every task that
    // transitively needs it fails.
    const reason = `upstream_deleted:${id}`;
    const marked = await this._propagateFailure(id, reason);
    this.counters.propagatedFailures += marked;

    // Step 2 — clean up the deleted task's edges and structures.
    for (const depId of task.dependencies) this._removeDependent(depId, id);
    this.dependents.delete(id);
    this.heap.remove(id);
    this.tasks.delete(id);

    this._countStatusChange(task.status, undefined);
    this.counters.deletions++;
    await this._fireHook('onTaskDeleted', task);
    // Dependents keep dangling references in their dependency sets —
    // harmless: step 1 already moved them to a terminal status.
  }

  private async _completeTask(id: string, now?: number): Promise<Task> {
    this._assertUsable();
    const task = this.tasks.get(id);
    if (!task) throw new UnknownTaskError(id);
    if (task.status === 'PENDING') {
      throw new InvalidStatusError(id, task.status, 'complete');
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new TerminalTaskError(id, task.status, 'complete');
    }

    const prev = task.status;
    const finishedAt = now ?? this._now();
    task.status = 'COMPLETED';
    task.failureReason = undefined;
    task.finishedAt = finishedAt;
    if (task.startedAt === undefined) task.startedAt = finishedAt;
    this._countStatusChange(prev, 'COMPLETED');
    if (this.heap.contains(id)) this.heap.remove(id);

    // Commit state first, then unblock dependents, then fire hooks —
    // hooks observe the final graph state.
    const unblocked = await this._unblockDependents(id);
    this.counters.unblocked += unblocked;
    await this._fireHook('onTaskCompleted', task);
    return task;
  }

  private async _failTask(id: string, reason?: string): Promise<Task> {
    this._assertUsable();
    const task = this.tasks.get(id);
    if (!task) throw new UnknownTaskError(id);
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new TerminalTaskError(id, task.status, 'fail');
    }
    return this._transitionToFailure(task, reason ?? 'explicit_failure');
  }

  private async _cancelTask(id: string, reason?: string): Promise<Task> {
    this._assertUsable();
    const task = this.tasks.get(id);
    if (!task) throw new UnknownTaskError(id);
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new TerminalTaskError(id, task.status, 'cancel');
    }
    const prev = task.status;
    task.status = 'CANCELLED';
    task.failureReason = reason ?? `cancelled:${id}`;
    task.finishedAt = this._now();
    this._countStatusChange(prev, 'CANCELLED');
    if (this.heap.contains(id)) this.heap.remove(id);
    const marked = await this._propagateFailure(id, task.failureReason);
    this.counters.propagatedFailures += marked;
    await this._fireHook('onTaskCancelled', task, task.failureReason);
    return task;
  }

  private async _transitionToFailure(task: Task, reason: string): Promise<Task> {
    const prev = task.status;
    task.status = 'FAILED';
    task.failureReason = reason;
    task.finishedAt = this._now();
    this._countStatusChange(prev, 'FAILED');
    if (this.heap.contains(task.id)) this.heap.remove(task.id);
    const marked = await this._propagateFailure(task.id, reason);
    this.counters.propagatedFailures += marked;
    await this._fireHook('onTaskFailed', task, reason);
    return task;
  }

  private async _resetTask(id: string): Promise<Task> {
    this._assertUsable();
    const task = this.tasks.get(id);
    if (!task) throw new UnknownTaskError(id);
    if (!TERMINAL_STATUSES.has(task.status)) {
      throw new InvalidStatusError(id, task.status, 'reset');
    }
    // Terminal → live: back to PENDING (or READY if all deps completed).
    // `attempts` is deliberately preserved — it records retry history.
    const prev = task.status;
    task.status = 'PENDING';
    task.failureReason = undefined;
    task.finishedAt = undefined;
    task.startedAt = undefined;
    this._countStatusChange(prev, 'PENDING');
    this.heap.remove(id);
    await this._reconcileStatus(task);
    this.counters.resets++;
    await this._fireHook('onTaskReset', task);
    return task;
  }

  private async _executeNextTask(now: number): Promise<NextTaskResult> {
    this._assertUsable();
    if (this.tasks.size === 0) return { kind: 'none' };

    const deferred: string[] = [];
    let chosen: Task | undefined;

    // Pop until an executable candidate is found. The heap contract is
    // "entries are READY tasks", so a non-executable READY entry is
    // future-dated (executeTime > now): collect and re-push it.
    // Non-READY entries are stale (missed maintenance): discard without
    // re-push — unblock events will re-enter such tasks into the heap
    // when their dependencies complete.
    while (true) {
      const id = this.heap.pop();
      if (id === undefined) break;
      const task = this.tasks.get(id);
      if (!task) continue; // stale entry (task deleted) — discard
      const executable =
        task.status === 'READY' && this._depsSatisfied(task) && task.executeTime <= now;
      if (!executable) {
        if (task.status === 'READY') deferred.push(id);
        continue;
      }
      chosen = task;
      break;
    }

    for (const id of deferred) {
      const t = this.tasks.get(id);
      // Re-verify before re-push: reentrant calls (runner or hook code
      // invoking scheduler methods mid-execution) may have changed the
      // task's status while the runner ran. Only still-READY tasks
      // re-enter the heap; everything else is discarded.
      if (t !== undefined && t.status === 'READY') this.heap.push(id);
    }
    if (chosen === undefined) return { kind: 'none' };

    // Reserve the chosen task as RUNNING.
    const prev = chosen.status;
    chosen.status = 'RUNNING';
    chosen.startedAt = now;
    chosen.attempts += 1;
    this._countStatusChange(prev, 'RUNNING');
    await this._fireHook('onTaskStarted', chosen);

    if (this.runner === undefined) {
      // Manual mode: the caller runs the work, then calls
      // completeTask / failTask when it finishes.
      return { kind: 'running', task: chosen, startedAt: now };
    }

    // Runner mode: execute inline, then transition + side effects.
    let error: string | undefined;
    try {
      await this.runner(chosen);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const finishedAt = this._now();

    if (error !== undefined) {
      const failedPrev = chosen.status;
      chosen.status = 'FAILED';
      chosen.failureReason = error;
      chosen.finishedAt = finishedAt;
      this._countStatusChange(failedPrev, 'FAILED');
      const marked = await this._propagateFailure(chosen.id, `execution_failed:${error}`);
      this.counters.propagatedFailures += marked;
      await this._fireHook('onTaskFailed', chosen, error);
      return {
        kind: 'executed',
        task: chosen,
        startedAt: now,
        finishedAt,
        durationMs: finishedAt - now,
        error,
      };
    }

    const completedPrev = chosen.status;
    chosen.status = 'COMPLETED';
    chosen.failureReason = undefined;
    chosen.finishedAt = finishedAt;
    this._countStatusChange(completedPrev, 'COMPLETED');
    const unblocked = await this._unblockDependents(chosen.id);
    this.counters.unblocked += unblocked;
    await this._fireHook('onTaskCompleted', chosen);
    this.counters.executed++;
    return {
      kind: 'executed',
      task: chosen,
      startedAt: now,
      finishedAt,
      durationMs: finishedAt - now,
    };
  }

  // ── Graph mechanics ─────────────────────────────────────────────────

  /** Ordering contract for the heap: higher priority first, then
   *  earlier executeTime, then earlier createdAt, then id. */
  private compareIds(a: string, b: string): number {
    const ta = this.tasks.get(a);
    const tb = this.tasks.get(b);
    if (!ta || !tb) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (ta.priority !== tb.priority) return ta.priority > tb.priority ? -1 : 1;
    if (ta.executeTime !== tb.executeTime) return ta.executeTime < tb.executeTime ? -1 : 1;
    if (ta.createdAt !== tb.createdAt) return ta.createdAt < tb.createdAt ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Register taskId as a dependent of depId (reverse edge). */
  private _addDependent(depId: string, taskId: string): void {
    let set = this.dependents.get(depId);
    if (!set) {
      set = new Set<string>();
      this.dependents.set(depId, set);
    }
    if (!set.has(taskId)) {
      set.add(taskId);
      this.counters.edges++;
    }
  }

  /** Unregister taskId from depId's dependent set (reverse edge). */
  private _removeDependent(depId: string, taskId: string): void {
    const set = this.dependents.get(depId);
    if (set && set.has(taskId)) {
      set.delete(taskId);
      this.counters.edges--;
      if (set.size === 0) this.dependents.delete(depId);
    }
  }

  /** True when every dependency of `task` exists and is COMPLETED.
   *  A missing (deleted) dependency counts as unsatisfied — the
   *  conservative semantics: the task stays blocked. */
  private _depsSatisfied(task: Task): boolean {
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.status !== 'COMPLETED') return false;
    }
    return true;
  }

  /**
   * First dependency that can never satisfy `task`: one that exists
   * but is already FAILED or CANCELLED. Such a dependency dooms the
   * task: it is marked FAILED and the failure propagates downstream.
   *
   * A missing (never-registered, or deleted) dependency is deliberately
   * NOT treated as failed here — forward references to not-yet-existing
   * tasks must remain satisfiable PENDING blockers. Dangling references
   * left behind by deleteTask are failed instead through the BFS in
   * _propagateFailure, which reaches them as victims of the deletion.
   */
  private _findFailedDep(task: Task): string | undefined {
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (dep !== undefined && (dep.status === 'FAILED' || dep.status === 'CANCELLED')) {
        return depId;
      }
    }
    return undefined;
  }

  /**
   * Recompute a task's executable status from the current state of its
   * dependencies, applying the matching side effects. Terminal tasks
   * are never touched (use resetTask to revive them).
   */
  private async _reconcileStatus(task: Task): Promise<void> {
    if (TERMINAL_STATUSES.has(task.status)) return;
    const failedDep = this._findFailedDep(task);
    if (failedDep !== undefined) {
      const prev = task.status;
      task.status = 'FAILED';
      task.failureReason = `upstream_failed:${failedDep}`;
      task.finishedAt = this._now();
      this._countStatusChange(prev, 'FAILED');
      if (this.heap.contains(task.id)) this.heap.remove(task.id);
      const marked = await this._propagateFailure(task.id, task.failureReason);
      this.counters.propagatedFailures += marked;
      await this._fireHook('onTaskFailed', task, task.failureReason);
      return;
    }
    if (this._depsSatisfied(task)) {
      if (task.status === 'PENDING') {
        const prev = task.status;
        task.status = 'READY';
        this._countStatusChange(prev, 'READY');
        this.heap.push(task.id);
        this.counters.unblocked++;
        await this._fireHook('onTaskUnblocked', task);
      }
      // Already READY: no transition needed.
      return;
    }
    if (task.status === 'READY') {
      // Satisfaction was lost (new/unmet dependency): demote and leave
      // the heap; the task stays PENDING until its deps complete.
      const prev = task.status;
      task.status = 'PENDING';
      this._countStatusChange(prev, 'PENDING');
      if (this.heap.contains(task.id)) this.heap.remove(task.id);
    }
    // Otherwise: stays PENDING (blocked on unfinished dependencies).
  }

  /** After a task completes, promote any direct dependent whose
   *  dependencies are now all COMPLETED from PENDING to READY.
   *  Returns the number promoted (hooks fire after the walk). */
  private async _unblockDependents(completedId: string): Promise<number> {
    const waiting = this.dependents.get(completedId);
    if (!waiting) return 0;
    const promoted: Task[] = [];
    for (const depId of [...waiting]) {
      const task = this.tasks.get(depId);
      if (!task || task.status !== 'PENDING') continue;
      if (this._depsSatisfied(task)) {
        const prev = task.status;
        task.status = 'READY';
        this._countStatusChange(prev, 'READY');
        this.heap.push(task.id);
        promoted.push(task);
      }
      // Deps still unmet → stays PENDING (blocked).
    }
    if (promoted.length > 0) {
      await this._fireHookBatch('onTaskUnblocked', promoted);
    }
    return promoted.length;
  }

  /**
   * Mark every non-terminal task reachable from `originId` through the
   * reverse (dependents) graph as FAILED with `reason`. Traversal
   * expands through already-FAILED/CANCELLED nodes (their dependents
   * are also victims) but never through COMPLETED ones (a completed
   * upstream satisfies, rather than blocks, its dependents — including
   * the retry-after-reset case, where a task completed before its
   * upstream failed on a later attempt). Returns the number marked.
   * Iterative — safe on graphs of any size. Hooks fire after the walk.
   */
  private async _propagateFailure(originId: string, reason: string): Promise<number> {
    const origin = this.tasks.get(originId);
    if (!origin) return 0;
    const marked: Task[] = [];
    const visited = new Set<string>([originId]);
    const queue: string[] = [];
    let head = 0;
    const dependentsOfOrigin = this.dependents.get(originId);
    if (dependentsOfOrigin) {
      for (const d of dependentsOfOrigin) {
        if (!visited.has(d)) {
          visited.add(d);
          queue.push(d);
        }
      }
    }
    while (head < queue.length) {
      const node = queue[head++]!;
      const task = this.tasks.get(node);
      if (!task) continue; // deleted — skip
      const status = task.status;
      if (!TERMINAL_STATUSES.has(status)) {
        const prev = status;
        task.status = 'FAILED';
        task.failureReason = reason;
        task.finishedAt = this._now();
        this._countStatusChange(prev, 'FAILED');
        marked.push(task);
        this._expandDependents(node, visited, queue);
      } else if (status === 'FAILED' || status === 'CANCELLED') {
        this._expandDependents(node, visited, queue);
      }
      // COMPLETED nodes are skipped entirely.
    }
    if (marked.length > 0) {
      this.counters.propagatedFailures += marked.length;
      await this._fireHookBatch('onTaskFailed', marked, reason);
    }
    return marked.length;
  }

  private _expandDependents(node: string, visited: Set<string>, queue: string[]): void {
    const ds = this.dependents.get(node);
    if (!ds) return;
    for (const d of ds) {
      if (!visited.has(d)) {
        visited.add(d);
        queue.push(d);
      }
    }
  }

  // ── Cycle detection ─────────────────────────────────────────────────

  /**
   * Adding edge taskId → depId creates a cycle iff depId can reach
   * taskId through existing dependency edges. Iterative BFS with an
   * array + head pointer (no O(n) shift). O(reachable subgraph).
   */
  private _wouldCreateCycle(taskId: string, depId: string): boolean {
    if (depId === taskId) return true; // self-loop is always a cycle
    const visited = new Set<string>([depId]);
    const queue: string[] = [depId];
    let head = 0;
    while (head < queue.length) {
      const node = queue[head++]!;
      if (node === taskId) return true;
      const deps = this.tasks.get(node)?.dependencies;
      if (deps) {
        for (const d of deps) {
          if (!visited.has(d)) {
            visited.add(d);
            queue.push(d);
          }
        }
      }
    }
    return false;
  }

  /** Witness path for a would-be cycle: depId → … → taskId, closed. */
  private _witnessPath(taskId: string, depId: string): string[] {
    const parent = new Map<string, string>();
    const visited = new Set<string>([depId]);
    const queue: string[] = [depId];
    let head = 0;
    while (head < queue.length) {
      const node = queue[head++]!;
      if (node === taskId) {
        const path: string[] = [node];
        let cur = node;
        while (cur !== depId) {
          const p = parent.get(cur);
          if (p === undefined) return [depId, taskId];
          path.push(p);
          cur = p;
        }
        return [...path.reverse(), depId];
      }
      const deps = this.tasks.get(node)?.dependencies;
      if (deps) {
        for (const d of deps) {
          if (!visited.has(d)) {
            visited.add(d);
            parent.set(d, node);
            queue.push(d);
          }
        }
      }
    }
    return [depId, taskId];
  }

  /** Validate a dependency list before any edge is registered: rejects
   *  self-dependencies, unknown references (strict mode), and
   *  cycle-creating edges. Returns the accepted set. */
  private _validateDeps(taskId: string, depList: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const depId of depList) {
      if (typeof depId !== 'string' || depId.length === 0) {
        throw new InvalidDependencyError(String(depId));
      }
      if (depId === taskId) {
        throw new CycleError(
          [taskId, taskId],
          `Self-dependency on task "${taskId}" would create a cycle`,
        );
      }
      const depTask = this.tasks.get(depId);
      if (!depTask) {
        if (!this.allowForwardRefs) throw new InvalidDependencyError(depId);
        out.add(depId);
        continue;
      }
      if (this._wouldCreateCycle(taskId, depId)) {
        throw new CycleError(
          this._witnessPath(taskId, depId),
          `Edge ${taskId} → ${depId} would create a dependency cycle`,
        );
      }
      out.add(depId);
    }
    return out;
  }

  /**
   * Full-graph cycle audit: iterative 3-color DFS (explicit stack —
   * recursive DFS over a 1M-node graph would overflow the JS call
   * stack) with early exit on the first back edge. O(V + E) worst
   * case. Returns the witness cycle when one is found.
   */
  private _findCycle(): CycleReport {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const parent = new Map<string, string>();
    const stack: DfsFrame[] = [];

    const dfsFrom = (root: string): CycleReport | null => {
      color.set(root, GRAY);
      stack.push({ node: root, deps: [...(this.tasks.get(root)?.dependencies ?? [])], depIdx: 0 });
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        if (frame.depIdx < frame.deps.length) {
          const d = frame.deps[frame.depIdx]!;
          frame.depIdx++;
          const cd = color.get(d);
          if (cd === undefined) {
            color.set(d, GRAY);
            parent.set(d, frame.node);
            stack.push({ node: d, deps: [...(this.tasks.get(d)?.dependencies ?? [])], depIdx: 0 });
          } else if (cd === GRAY) {
            return { hasCycle: true, cycle: this._extractCycle(frame.node, d, parent) };
          }
          // BLACK → already fully explored: cross/forward edge, not a cycle.
        } else {
          color.set(frame.node, BLACK);
          stack.pop();
        }
      }
      return null;
    };

    for (const id of this.tasks.keys()) {
      if (color.has(id)) continue;
      const found = dfsFrom(id);
      if (found) return found;
    }
    return { hasCycle: false };
  }

  /** Reconstruct the cycle path from parent pointers when a back edge
   *  (descendant → ancestor, both in the active DFS stack) is found. */
  private _extractCycle(descendant: string, ancestor: string, parent: Map<string, string>): string[] {
    const path: string[] = [descendant];
    let cur = descendant;
    while (cur !== ancestor) {
      const p = parent.get(cur);
      if (p === undefined) return [descendant, ancestor];
      path.push(p);
      cur = p;
    }
    return [...path.reverse(), ancestor];
  }

  // ── Plumbing ────────────────────────────────────────────────────────

  /**
   * Single-writer serialization with a reentrant bypass.
   *
   * Independent submissions chain behind the pending queue, strictly in
   * submission order — concurrent callers never observe interleaved
   * state. Nested submissions (recognizable because they carry the
   * writer token of the currently-executing operation, propagated across
   * async boundaries by AsyncLocalStorage) run immediately: queueing
   * them behind the operation that awaits them would be a circular
   * wait. Because the event loop admits only one executing operation at
   * a time, single-writer semantics are preserved either way.
   *
   * Settled operations are dequeued, so retained memory is proportional
   * to the in-flight backlog — not to the scheduler's entire history.
   */
  private _serialized<T>(op: () => T | Promise<T>): Promise<T> {
    const store = this.storage.getStore();
    const token: WriterToken = { opId: Symbol('scheduler-op') };
    // Every execution — queued or reentrant — runs under its own token
    // with `_current` set for the duration, so nested submissions at any
    // depth are recognized as reentrant by `store.opId === this._current`.
    // Without this, a nested call would queue behind the operation that
    // awaits it: a circular wait that deadlocks the scheduler.
    const wrapped = async (): Promise<T> => {
      const prev = this._current;
      this._current = token.opId;
      try {
        return await op();
      } finally {
        this._current = prev;
      }
    };
    if (store !== undefined && store.opId === this._current) {
      // Reentrant submission: part of the currently-executing
      // operation's transaction. Run immediately, outside the queue.
      return this.storage.run(token, wrapped);
    }
    const tail = this._disposed
      ? this._head
      : (this._pending[this._pending.length - 1] ?? this._head);
    const run = tail.then(() => this.storage.run(token, wrapped));
    this._pending.push(run);
    // Dequeue on settlement so the retained set stays bounded.
    void run
      .catch(() => undefined)
      .then(() => {
        const i = this._pending.indexOf(run);
        if (i !== -1) this._pending.splice(i, 1);
      });
    return run;
  }

  private _assertUsable(): void {
    if (this._disposed) throw new DisposedSchedulerError();
  }

  private _now(): number {
    return this.nowProvider();
  }

  /** Await a single hook; failures are recorded, never propagated —
   *  state transitions commit before hooks fire, and hooks are
   *  advisory. */
  private async _fireHook(hookName: keyof SchedulerHooks, task: Task, extra?: unknown): Promise<void> {
    const fn = this.hooks[hookName] as unknown as AnyHook | undefined;
    if (!fn) return;
    try {
      await fn(task, ...(extra !== undefined ? [extra] : []));
    } catch (e) {
      this._recordHookError(e, hookName, task.id);
    }
  }

  /** Await hooks sequentially for a batch of tasks. */
  private async _fireHookBatch(hookName: keyof SchedulerHooks, tasks: Task[], extra?: unknown): Promise<void> {
    const fn = this.hooks[hookName] as unknown as AnyHook | undefined;
    if (!fn) return;
    for (const task of tasks) {
      try {
        await fn(task, ...(extra !== undefined ? [extra] : []));
      } catch (e) {
        this._recordHookError(e, hookName, task.id);
      }
    }
  }

  private _recordHookError(e: unknown, hookName: keyof SchedulerHooks, taskId: string): void {
    const message = e instanceof Error ? e.message : String(e);
    this.lastError = `hook ${String(hookName)} (${taskId}): ${message}`;
    this.counters.hookErrors++;
  }

  /** Apply a status transition and keep the incremental counters exact.
   *  Either argument may be undefined (task created / deleted). */
  private _countStatusChange(prev: TaskStatus | undefined, next: TaskStatus | undefined): void {
    if (prev !== undefined) this.counters.byStatus[prev] -= 1;
    if (next !== undefined) this.counters.byStatus[next] += 1;
  }

  private _clearInternal(): void {
    this.tasks.clear();
    this.dependents.clear();
    this.heap.clear();
    this.counters.byStatus = { PENDING: 0, READY: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 };
    this.counters.edges = 0;
    this.counters.executed = 0;
    this.counters.unblocked = 0;
    this.counters.propagatedFailures = 0;
    this.counters.upserts = 0;
    this.counters.deletions = 0;
    this.counters.resets = 0;
    this.counters.cycleAudits = 0;
    this.counters.hookErrors = 0;
    this.lastError = undefined;
  }
}
