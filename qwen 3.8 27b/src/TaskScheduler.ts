import { BinaryHeap, type Comparator } from './BinaryHeap';
import {
  Task,
  TaskStatus,
  AddTaskInput,
  UpdateTaskInput,
  SchedulerOptions,
  SchedulerMetrics,
  BlockedTask,
  TaskExecutor,
} from './types';
import {
  InvalidTaskError,
  TaskNotFoundError,
  DuplicateTaskError,
  CapacityExceededError,
  CycleError,
  StaleVersionError,
} from './errors';

type Hooks = Pick<
  SchedulerOptions,
  'onTaskClaimed' | 'onTaskCompleted' | 'onTaskFailed' | 'onTaskCancelled'
>;

/**
 * Heap ordering: highest priority first; ties broken by earliest execution
 * time, then by creation sequence (deterministic FIFO).
 */
const dueComparator: Comparator<Task> = (a, b) =>
  b.priority - a.priority || a.executeTime - b.executeTime || a.sequence - b.sequence;

/**
 * Future-queue ordering: earliest due time first so the promotion gate can
 * peek the next wake-up in O(1); priority breaks ties within a time.
 */
const futureComparator: Comparator<Task> = (a, b) =>
  a.executeTime - b.executeTime || b.priority - a.priority || a.sequence - b.sequence;

const PRE_EXECUTION = new Set<TaskStatus>([
  TaskStatus.PENDING,
  TaskStatus.READY,
  TaskStatus.RUNNING,
]);

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

interface DfsFrame {
  node: string;
  iter: Iterator<string>;
}

/**
 * TaskScheduler — production-ready in-memory task scheduler.
 *
 * Design overview (see ARCHITECTURE.md for the full rationale):
 *
 *   tasks        Map<id, Task>                  O(1) CRUD + status source of truth
 *   depsOf       Map<id, Set<depId>>            forward edges (deduped), cycle detection
 *   dependents   Map<depId, Set<id>>            reverse edges, O(1) unblock propagation
 *   dueHeap      BinaryHeap<Task>               READY ∧ due, key (priority ↓, time ↑, seq ↑)
 *   futureHeap   BinaryHeap<Task>               READY ∧ not-due, key (time ↑, priority ↓, seq ↑)
 *
 * Key invariants:
 *   1. Every READY task is in exactly one heap (due or future) and nowhere else.
 *   2. Key fields (priority, executeTime, sequence) of a heap member are never
 *      mutated in place — updateTask removes before mutating, re-inserts after.
 *   3. The clock is monotonic: a backward `now` is ignored (counted in metrics).
 *   4. `unmetDependencies` is decremented only on the dependent side of a
 *      completion; it is recomputed from scratch on reconcile and update.
 *
 * Time model: two-heap lazy promotion. `claimNextExecutable` promotes tasks
 * whose executeTime has passed (each task is promoted at most once until its
 * time passes again via update), so the expensive "priority head of future
 * tasks" degeneracy of single-heap pop-and-collect designs is avoided.
 */
export class TaskScheduler {
  private readonly tasks = new Map<string, Task>();
  private readonly depsOf = new Map<string, Set<string>>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly dueHeap = new BinaryHeap<Task>(dueComparator);
  private readonly futureHeap = new BinaryHeap<Task>(futureComparator);

  private clock: number;
  private readonly maxTasks: number;
  private readonly hooks: Hooks;
  private sequence = 0;
  private totalEdges = 0;

  private readonly byStatus: Record<TaskStatus, number> = {
    [TaskStatus.PENDING]: 0,
    [TaskStatus.READY]: 0,
    [TaskStatus.RUNNING]: 0,
    [TaskStatus.COMPLETED]: 0,
    [TaskStatus.FAILED]: 0,
    [TaskStatus.CANCELLED]: 0,
  };

  private readonly counters = {
    added: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    deleted: 0,
    promotions: 0,
    staleDiscards: 0,
    clockRegressionsIgnored: 0,
  };

  constructor(options: SchedulerOptions = {}) {
    if (options.now !== undefined && !Number.isFinite(options.now)) {
      throw new InvalidTaskError('options.now must be a finite number');
    }
    if (
      options.maxTasks !== undefined &&
      (!Number.isInteger(options.maxTasks) || options.maxTasks < 0)
    ) {
      throw new InvalidTaskError('options.maxTasks must be a non-negative integer');
    }
    this.clock = options.now ?? Date.now();
    this.maxTasks = options.maxTasks ?? 0;
    this.hooks = {
      onTaskClaimed: options.onTaskClaimed,
      onTaskCompleted: options.onTaskCompleted,
      onTaskFailed: options.onTaskFailed,
      onTaskCancelled: options.onTaskCancelled,
    };
  }

  /** Current scheduler clock (epoch ms). Monotonic. */
  get currentClock(): number {
    return this.clock;
  }

  // ------------------------------------------------------------------ //
  //  Task CRUD
  // ------------------------------------------------------------------ //

  /**
   * Add a task. O(d + log n) where d = number of dependencies.
   *
   * Validation: id format; finite priority/executeTime; dependencies exist
   * (no forward references — by design, the graph is complete at edge-creation
   * time); no self-dependency; duplicate deps are deduplicated; capacity.
   * A new task cannot create a transitive cycle (it has no outgoing-into-old
   * path), so no cycle search is needed here.
   */
  addTask(input: AddTaskInput): Task {
    this._validateId(input.id);
    if (input.priority !== undefined && !Number.isFinite(input.priority)) {
      throw new InvalidTaskError(`priority for '${input.id}' must be a finite number`);
    }
    if (input.executeTime !== undefined && !Number.isFinite(input.executeTime)) {
      throw new InvalidTaskError(`executeTime for '${input.id}' must be a finite number`);
    }
    const priority = input.priority ?? 0;
    const executeTime = input.executeTime ?? this.clock;

    const dependencies = this._validateDependencies(
      input.id,
      input.dependencies,
      'addTask'
    );

    if (this.maxTasks > 0 && this.tasks.size >= this.maxTasks) {
      throw new CapacityExceededError(this.maxTasks);
    }
    if (this.tasks.has(input.id)) {
      throw new DuplicateTaskError(input.id);
    }

    const unmet = this._countUnmet(input.id, dependencies);
    const status = unmet === 0 ? TaskStatus.READY : TaskStatus.PENDING;
    const task: Task = {
      id: input.id,
      payload: input.payload ?? null,
      priority,
      executeTime,
      dependencies,
      status,
      unmetDependencies: unmet,
      version: 0,
      createdAt: this.clock,
      updatedAt: this.clock,
      sequence: this.sequence++,
    };

    this.tasks.set(task.id, task);
    this.depsOf.set(task.id, new Set(dependencies));
    for (const dep of dependencies) {
      let set = this.dependents.get(dep);
      if (!set) {
        set = new Set<string>();
        this.dependents.set(dep, set);
      }
      set.add(task.id);
    }
    this.totalEdges += dependencies.length;
    this.byStatus[status]++;
    if (status === TaskStatus.READY) {
      this._heapInsert(task);
    }
    // Re-add of a previously deleted id: dependents that still list this id
    // keep their edge (fail-safe), but their unmet counts were computed
    // against the OLD task instance. Reconcile them so bookkeeping matches
    // reality and completeTask's unblock propagation resumes correctly.
    // For a brand-new id `inbound` is undefined — zero cost on the common path.
    const inbound = this.dependents.get(task.id);
    if (inbound) {
      for (const cid of inbound) {
        const c = this.tasks.get(cid);
        if (!c || (c.status !== TaskStatus.PENDING && c.status !== TaskStatus.READY)) continue;
        c.unmetDependencies = this._countUnmet(cid, c.dependencies);
        if (c.unmetDependencies > 0) {
          if (c.status === TaskStatus.READY) {
            this._heapRemove(c);
            this._setStatus(c, TaskStatus.PENDING);
          }
        } else if (c.status === TaskStatus.PENDING) {
          this._setStatus(c, TaskStatus.READY);
          this._heapInsert(c);
        }
      }
    }
    this.counters.added++;
    return task;
  }

  /**
   * Batch add. Per-task validation identical to addTask; transitive cycle
   * checking is skipped (a task cannot reference itself, and edges among
   * batch members are validated for existence in a second pass). Run
   * findCycle() afterwards if the batch source is untrusted.
   * O(Σd + k·log n) where k = tasks starting READY.
   */
  addTasks(inputs: readonly AddTaskInput[]): number {
    if (this.maxTasks > 0 && this.tasks.size + inputs.length > this.maxTasks) {
      throw new CapacityExceededError(this.maxTasks);
    }
    // Pass 1: ids well-formed and unique (batch ∪ existing).
    const batchIds = new Set<string>();
    for (const input of inputs) {
      this._validateId(input.id);
      if (this.tasks.has(input.id)) throw new DuplicateTaskError(input.id);
      if (batchIds.has(input.id)) throw new DuplicateTaskError(input.id);
      batchIds.add(input.id);
    }
    // Pass 2: create all records (deps may point at later batch members).
    const created: Task[] = [];
    for (const input of inputs) {
      if (input.priority !== undefined && !Number.isFinite(input.priority)) {
        throw new InvalidTaskError(`priority for '${input.id}' must be a finite number`);
      }
      if (input.executeTime !== undefined && !Number.isFinite(input.executeTime)) {
        throw new InvalidTaskError(`executeTime for '${input.id}' must be a finite number`);
      }
      const dependencies = this._validateDependencies(input.id, input.dependencies, 'addTasks', batchIds);
      const task: Task = {
        id: input.id,
        payload: input.payload ?? null,
        priority: input.priority ?? 0,
        executeTime: input.executeTime ?? this.clock,
        dependencies,
        status: TaskStatus.PENDING, // provisionally; resolved in pass 3
        unmetDependencies: 0,
        version: 0,
        createdAt: this.clock,
        updatedAt: this.clock,
        sequence: this.sequence++,
      };
      this.tasks.set(task.id, task);
      this.depsOf.set(task.id, new Set(dependencies)); // reserve the key; edges are counted in pass 3
      created.push(task);
    }
    // Pass 3: edges, unmet counts, statuses, heap membership.
    const due: Task[] = [];
    const future: Task[] = [];
    for (const task of created) {
      const deps = this.depsOf.get(task.id)!;
      for (const dep of deps) {
        let set = this.dependents.get(dep);
        if (!set) {
          set = new Set<string>();
          this.dependents.set(dep, set);
        }
        set.add(task.id);
      }
      this.totalEdges += deps.size;
      task.unmetDependencies = this._countUnmet(task.id, task.dependencies);
      if (task.unmetDependencies === 0) {
        task.status = TaskStatus.READY;
        this.byStatus[TaskStatus.READY]++;
        if (task.executeTime <= this.clock) {
          due.push(task);
        } else {
          future.push(task);
        }
      } else {
        this.byStatus[TaskStatus.PENDING]++;
      }
    }
    this.dueHeap.heapify(due);
    this.futureHeap.heapify(future);
    this.counters.added += created.length;
    return created.length;
  }

  /**
   * Update a non-terminal, non-running task. O(d + log n) plus an
   * O(V+E)-bounded reachability check per newly added dependency edge
   * (early-exit in practice).
   *
   * `dependencies` re-validates existence and rejects any edge that would
   * create a cycle (checked BEFORE mutation, so a rejected update is atomic).
   * `expectedVersion` enables optimistic concurrency control.
   */
  updateTask(id: string, updates: UpdateTaskInput, expectedVersion?: number): Task {
    const task = this._getOrThrow(id);
    if (expectedVersion !== undefined && task.version !== expectedVersion) {
      throw new StaleVersionError(id, expectedVersion, task.version);
    }
    if (task.status === TaskStatus.RUNNING) {
      throw new InvalidTaskError(
        `task '${id}' is RUNNING; it is in flight and cannot be updated (complete, fail or cancel it first)`
      );
    }
    if (!PRE_EXECUTION.has(task.status)) {
      throw new InvalidTaskError(
        `task '${id}' is ${task.status}; terminal tasks are immutable`
      );
    }

    let newPriority = task.priority;
    let newExecuteTime = task.executeTime;
    let newPayload = task.payload;
    let newDeps: string[] | null | undefined = undefined; // undefined = no change

    if ('payload' in updates) {
      newPayload = updates.payload;
    }
    if (updates.priority !== undefined) {
      if (!Number.isFinite(updates.priority)) {
        throw new InvalidTaskError(`priority for '${id}' must be a finite number`);
      }
      newPriority = updates.priority;
    }
    if (updates.executeTime !== undefined) {
      if (!Number.isFinite(updates.executeTime)) {
        throw new InvalidTaskError(`executeTime for '${id}' must be a finite number`);
      }
      newExecuteTime = updates.executeTime;
    }
    if ('dependencies' in updates) {
      newDeps =
        updates.dependencies === null
          ? []
          : this._validateDependencies(id, updates.dependencies, 'updateTask');
    }

    // Cycle check BEFORE any mutation: edge id→d (id depends on d) closes a
    // cycle iff d already reaches id. Checked only for genuinely new edges.
    if (newDeps !== undefined) {
      const oldDeps = this.depsOf.get(id)!;
      for (const dep of newDeps) {
        if (oldDeps.has(dep)) continue;
        const path = this._depPath(dep, id);
        if (path) {
          throw new CycleError(
            `adding dependency '${dep}' to '${id}' would create a cycle: ${[id, ...path].join(' → ')}`,
            [id, ...path]
          );
        }
      }
    }

    // ---- commit ------------------------------------------------------ //
    this._heapRemove(task);

    task.payload = newPayload;
    task.priority = newPriority;
    task.executeTime = newExecuteTime;

    if (newDeps !== undefined) {
      const oldDeps = this.depsOf.get(id)!;
      for (const dep of oldDeps) {
        this.dependents.get(dep)?.delete(id);
      }
      for (const dep of newDeps) {
        let set = this.dependents.get(dep);
        if (!set) {
          set = new Set<string>();
          this.dependents.set(dep, set);
        }
        set.add(id);
      }
      this.totalEdges += newDeps.length - oldDeps.size;
      this.depsOf.set(id, new Set(newDeps));
      task.dependencies = [...newDeps];
      task.unmetDependencies = this._countUnmet(id, newDeps);

      if (task.status === TaskStatus.READY && task.unmetDependencies > 0) {
        this._setStatus(task, TaskStatus.PENDING);
      } else if (task.status === TaskStatus.PENDING && task.unmetDependencies === 0) {
        this._setStatus(task, TaskStatus.READY);
      }
    }

    task.version++;
    task.updatedAt = this.clock;
    if (task.status === TaskStatus.READY) {
      this._heapInsert(task);
    }
    return task;
  }

  /**
   * Delete a task. O(d_in + d_out + log n).
   *
   * Fail-safe semantics: dependents KEEP their dependency edge, which becomes
   * dangling. They remain blocked (never auto-executed) and are surfaced by
   * getBlockedTasks() / metrics. Dangling edges are counted as missing
   * dependencies, so a later re-add of the same id re-blocks every dependent
   * (see the reconciliation pass in addTask); when the re-added task
   * completes, unblock propagation resumes through the retained inbound
   * `dependents` list.
   */
  deleteTask(id: string): Task {
    const task = this._getOrThrow(id);
    this._heapRemove(task);

    const outDeps = this.depsOf.get(id)!;
    for (const dep of outDeps) {
      this.dependents.get(dep)?.delete(id);
    }
    // Inbound list intentionally retained (see doc comment).
    // Edge accounting: dangling inbound references (dependents that still
    // list a deleted id) are no longer graph edges — recount from the
    // surviving task records. O(n·d), fine for a rare operation.
    this.depsOf.delete(id);
    this.tasks.delete(id);
    this.totalEdges = this._recountEdges();
    this.byStatus[task.status]--;
    this.counters.deleted++;
    return task;
  }

  /** Ground-truth edge count: Σ depsOf(t).size over surviving tasks. */
  private _recountEdges(): number {
    let n = 0;
    for (const set of this.depsOf.values()) n += set.size;
    return n;
  }

  // ------------------------------------------------------------------ //
  //  Lifecycle transitions
  // ------------------------------------------------------------------ //

  /**
   * Mark a task completed (works from PENDING/READY/RUNNING — operator force
   * or normal completion after claim). Idempotent from COMPLETED. Throws from
   * FAILED/CANCELLED (completing a failed/cancelled task is a semantic
   * override with no API path by design).
   * O(d_out + log n).
   */
  completeTask(id: string): Task {
    const task = this._getOrThrow(id);
    if (task.status === TaskStatus.COMPLETED) {
      return task;
    }
    if (task.status === TaskStatus.FAILED || task.status === TaskStatus.CANCELLED) {
      throw new InvalidTaskError(
        `cannot complete a ${task.status} task`
      );
    }

    this._heapRemove(task);
    this._setStatus(task, TaskStatus.COMPLETED);
    this.counters.completed++;
    this.hooks.onTaskCompleted?.(task);

    // Unblock dependents. A just-completed task's dependents are always
    // PENDING (a READY dependent would already have counted this dep as met),
    // so a single decrement each suffices; guarded defensively anyway.
    const dependents = this.dependents.get(id);
    if (dependents) {
      for (const dependentId of dependents) {
        const child = this.tasks.get(dependentId);
        if (!child || child.status !== TaskStatus.PENDING) continue;
        if (child.unmetDependencies > 0) {
          child.unmetDependencies--;
        }
        if (child.unmetDependencies === 0) {
          this._setStatus(child, TaskStatus.READY);
          this._heapInsert(child);
        }
      }
    }
    return task;
  }

  /**
   * Mark a task failed. From terminal states: no-op (idempotent) except
   * COMPLETED, which throws. Dependents remain blocked (fail-safe).
   */
  failTask(id: string, reason?: unknown): Task {
    const task = this._getOrThrow(id);
    if (task.status === TaskStatus.FAILED) {
      return task;
    }
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.CANCELLED) {
      throw new InvalidTaskError(`cannot fail a ${task.status} task`);
    }
    this._heapRemove(task);
    this._setStatus(task, TaskStatus.FAILED);
    task.failureReason = reason;
    this.counters.failed++;
    this.hooks.onTaskFailed?.(task);
    return task;
  }

  /**
   * Cancel a task (operator abandon, incl. in-flight). No-op from terminal
   * states. Dependents remain blocked.
   */
  cancelTask(id: string): Task {
    const task = this._getOrThrow(id);
    if (!PRE_EXECUTION.has(task.status)) {
      return task;
    }
    this._heapRemove(task);
    this._setStatus(task, TaskStatus.CANCELLED);
    this.counters.cancelled++;
    this.hooks.onTaskCancelled?.(task);
    return task;
  }

  // ------------------------------------------------------------------ //
  //  Execution
  // ------------------------------------------------------------------ //

  /**
   * Claim the next executable task: highest priority among (READY ∧ due ∧
   * deps satisfied). Marks it RUNNING and fires onTaskClaimed. Returns null
   * when nothing is executable.
   *
   * Amortized O((p + s + 1) · log n): p = promotions this call, s = stale
   * heap entries discarded. Promotions are monotonic (each task promotes at
   * most once per time window), so steady-state claims are O(log n).
   */
  claimNextExecutable(now?: number): Task | null {
    const task = this._findNext(now);
    if (!task) return null;
    this.dueHeap.remove(task.id);
    this._setStatus(task, TaskStatus.RUNNING);
    this.counters.claimed++;
    this.hooks.onTaskClaimed?.(task);
    return task;
  }

  /**
   * Non-mutating peek of claimNextExecutable's answer. Stale entries are
   * still discarded (heap bookkeeping), but no task status changes and the
   * answer remains claimable.
   */
  peekNextExecutable(now?: number): Task | null {
    return this._findNext(now);
  }

  /**
   * Claim, run `executor` (sync or async), complete on success, fail on
   * throw (original error re-thrown after failTask). Returns null if nothing
   * is executable. The task stays RUNNING while the promise is pending.
   */
  async executeNextTask(executor: TaskExecutor, now?: number): Promise<Task | null> {
    const task = this.claimNextExecutable(now);
    if (!task) return null;
    try {
      await executor(task);
      this.completeTask(task.id);
      return task;
    } catch (err) {
      this.failTask(task.id, err);
      throw err;
    }
  }

  /**
   * Earliest time at which any new task could become due, or this.clock if
   * something is already claimable, or null when no clock-driven wake is
   * pending. O(1).
   *
   * Only heap-resident (READY) tasks schedule wakes: PENDING tasks unblock on
   * completion (not on the clock), RUNNING tasks are in flight, and blocked
   * tasks need operator action. Returning null instead of this.clock on
   * "all done" is what lets a host loop terminate (the scheduler may still
   * hold terminal/blocked tasks — tasks.size alone is not a signal).
   */
  nextWakeTime(): number | null {
    if (this.dueHeap.size > 0) {
      return this.clock;
    }
    const top = this.futureHeap.peek();
    if (top) {
      return top.executeTime;
    }
    return null;
  }

  // ------------------------------------------------------------------ //
  //  Queries (O(n·d) diagnostics — keep out of hot paths)
  // ------------------------------------------------------------------ //

  getTask(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getReadyTasks(): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === TaskStatus.READY) out.push(t);
    }
    return out;
  }

  getPendingTasks(): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === TaskStatus.PENDING) out.push(t);
    }
    return out;
  }

  /** READY ∧ due ∧ deps actually satisfied (dangling-dep guard). */
  getExecutableTasks(): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (
        t.status === TaskStatus.READY &&
        t.executeTime <= this.clock &&
        this._dependenciesSatisfied(t)
      ) {
        out.push(t);
      }
    }
    return out;
  }

  /**
   * Tasks that cannot execute right now and why: PENDING/READY tasks with
   * uncompleted (missing) or deleted (dangling) dependencies.
   */
  getBlockedTasks(): BlockedTask[] {
    const out: BlockedTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== TaskStatus.PENDING && t.status !== TaskStatus.READY) continue;
      const missing: string[] = [];
      const dangling: string[] = [];
      for (const dep of t.dependencies) {
        const depTask = this.tasks.get(dep);
        if (!depTask) {
          dangling.push(dep);
        } else if (depTask.status !== TaskStatus.COMPLETED) {
          missing.push(dep);
        }
      }
      if (missing.length > 0 || dangling.length > 0) {
        out.push({ task: t, missing, dangling });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ //
  //  Cycle detection (iterative — safe on million-node graphs)
  // ------------------------------------------------------------------ //

  /** O(V+E) scan; true iff the dependency graph contains a cycle. */
  hasCycle(): boolean {
    return this.findCycle() !== null;
  }

  /**
   * Iterative 3-color DFS over the forward dependency graph. Returns a
   * closed cycle path [a, b, c, a] (each node depends on the next) or null.
   * O(V+E) time, O(V) stack — no recursion, so 1M-deep chains cannot
   * overflow the call stack.
   */
  findCycle(): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();

    for (const start of this.tasks.keys()) {
      if (color.get(start) === BLACK) continue;
      color.set(start, GRAY);
      const stack: DfsFrame[] = [
        { node: start, iter: (this.depsOf.get(start) ?? EMPTY_SET)[Symbol.iterator]() },
      ];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const next = frame.iter.next();
        if (!next.done) {
          const dep = next.value;
          const c = color.get(dep) ?? WHITE;
          if (c === GRAY) {
            const path: string[] = stack.map((f) => f.node);
            const k = path.indexOf(dep);
            return [dep, ...path.slice(k + 1), dep];
          }
          if (c === WHITE) {
            color.set(dep, GRAY);
            stack.push({
              node: dep,
              iter: (this.depsOf.get(dep) ?? EMPTY_SET)[Symbol.iterator]()!,
            });
          }
          // BLACK: already fully explored, skip.
        } else {
          color.set(frame.node, BLACK);
          stack.pop();
        }
      }
    }
    return null;
  }

  /**
   * Would adding edge `taskId → depId` (taskId depends on depId) create a
   * cycle? I.e. can depId already reach taskId through existing dependencies?
   * O(V+E) worst case, early exit. Used by updateTask; exposed for external
   * graph-edit planning.
   */
  wouldCreateCycle(taskId: string, dependencyId: string): boolean {
    return this._depPath(dependencyId, taskId) !== null;
  }

  // ------------------------------------------------------------------ //
  //  Metrics / maintenance
  // ------------------------------------------------------------------ //

  /** O(1) — all counters are maintained incrementally. */
  metrics(): SchedulerMetrics {
    return {
      total: this.tasks.size,
      byStatus: { ...this.byStatus },
      dueHeapSize: this.dueHeap.size,
      futureHeapSize: this.futureHeap.size,
      totalEdges: this.totalEdges,
      clock: this.clock,
      ...this.counters,
    };
  }

  /** Wipe all state. The scheduler clock and counters are reset. */
  clear(): void {
    this.tasks.clear();
    this.depsOf.clear();
    this.dependents.clear();
    this.dueHeap.clear();
    this.futureHeap.clear();
    this.sequence = 0;
    this.totalEdges = 0;
    for (const k of Object.keys(this.byStatus) as TaskStatus[]) {
      this.byStatus[k] = 0;
    }
    for (const k of Object.keys(this.counters) as Array<keyof typeof this.counters>) {
      this.counters[k] = 0;
    }
  }

  // ------------------------------------------------------------------ //
  //  Internals
  // ------------------------------------------------------------------ //

  private _getOrThrow(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  private _validateId(id: unknown): void {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new InvalidTaskError('task id must be a non-empty string');
    }
  }

  /**
   * Validate dependency ids: non-empty strings, no self-reference, existing
   * (or within `batchIds` for addTasks). Returns a deduplicated list in
   * original order.
   */
  private _validateDependencies(
    taskId: string,
    raw: readonly string[] | null | undefined,
    context: string,
    batchIds?: ReadonlySet<string>
  ): string[] {
    if (raw === null || raw === undefined) return [];
    if (!Array.isArray(raw)) {
      throw new InvalidTaskError(`dependencies for '${taskId}' must be an array`);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const dep of raw) {
      if (typeof dep !== 'string' || dep.trim() === '') {
        throw new InvalidTaskError(
          `each dependency of '${taskId}' must be a non-empty string`
        );
      }
      if (dep === taskId) {
        throw new CycleError(
          `task '${taskId}' cannot depend on itself`,
          [taskId, taskId]
        );
      }
      if (seen.has(dep)) continue; // deduplicate
      const exists = batchIds ? this.tasks.has(dep) || batchIds.has(dep) : this.tasks.has(dep);
      if (!exists) {
        throw new InvalidTaskError(
          `dependency '${dep}' of '${taskId}' does not exist (${context}); forward references are not supported`
        );
      }
      seen.add(dep);
      out.push(dep);
    }
    return out;
  }

  private _countUnmet(taskId: string, deps: readonly string[]): number {
    let unmet = 0;
    for (const dep of deps) {
      const depTask = this.tasks.get(dep);
      if (!depTask || depTask.status !== TaskStatus.COMPLETED) unmet++;
    }
    return unmet;
  }

  /** True iff every dependency exists and is COMPLETED. O(d). */
  private _dependenciesSatisfied(task: Task): boolean {
    for (const dep of task.dependencies) {
      const depTask = this.tasks.get(dep);
      if (!depTask || depTask.status !== TaskStatus.COMPLETED) return false;
    }
    return true;
  }

  private _heapInsert(task: Task): void {
    if (task.executeTime <= this.clock) {
      this.dueHeap.push(task);
    } else {
      this.futureHeap.push(task);
    }
  }

  private _heapRemove(task: Task): void {
    if (this.dueHeap.contains(task.id)) {
      this.dueHeap.remove(task.id);
    } else if (this.futureHeap.contains(task.id)) {
      this.futureHeap.remove(task.id);
    }
  }

  private _setStatus(task: Task, status: TaskStatus): void {
    if (task.status === status) return;
    this.byStatus[task.status]--;
    this.byStatus[status]++;
    task.status = status;
    task.updatedAt = this.clock;
  }

  /** Recompute unmetDependencies from actual dep state; task goes PENDING. */
  private _reconcileBlocked(task: Task): void {
    task.unmetDependencies = this._countUnmet(task.id, task.dependencies);
    this._setStatus(task, TaskStatus.PENDING);
  }

  private _advanceClock(now: number | undefined): void {
    if (now === undefined) return;
    if (!Number.isFinite(now)) {
      throw new InvalidTaskError('now must be a finite number');
    }
    if (now > this.clock) {
      this.clock = now;
    } else if (now < this.clock) {
      this.counters.clockRegressionsIgnored++;
    }
  }

  /**
   * Move every READY task whose executeTime has passed from futureHeap to
   * dueHeap. Each task promotes at most once per time window, so this is
   * amortized O(1) per claim. Stale entries (task deleted, or no longer
   * READY after an update that missed a removal — defensive) are discarded.
   */
  private _promoteDue(): void {
    for (;;) {
      const top = this.futureHeap.peek();
      if (!top || top.executeTime > this.clock) return;
      this.futureHeap.pop();
      const task = this.tasks.get(top.id);
      if (task && task.status === TaskStatus.READY) {
        this.dueHeap.push(task);
        this.counters.promotions++;
      } else {
        this.counters.staleDiscards++;
      }
    }
  }

  /**
   * Find (without claiming) the next executable task: promote due tasks,
   * then walk the due heap top discarding stale entries until the top is
   * READY ∧ due ∧ deps satisfied. The answer stays in the heap.
   */
  private _findNext(now?: number): Task | null {
    this._advanceClock(now);
    this._promoteDue();
    for (;;) {
      const top = this.dueHeap.peek();
      if (!top) return null;
      const task = this.tasks.get(top.id);
      if (!task || task.status !== TaskStatus.READY) {
        this.dueHeap.remove(top.id);
        this.counters.staleDiscards++;
        continue;
      }
      if (task.executeTime > this.clock) {
        // Only reachable after a clock regression (ignored) — demote back.
        this.dueHeap.remove(top.id);
        this.futureHeap.push(task);
        continue;
      }
      if (!this._dependenciesSatisfied(task)) {
        // Dangling dependency: a dep was deleted after this task was
        // unblocked. Re-block it (recompute unmet, back to PENDING).
        this.dueHeap.remove(top.id);
        this._reconcileBlocked(task);
        this.counters.staleDiscards++;
        continue;
      }
      return task;
    }
  }

  /**
   * Iterative reachability: does `from` reach `to` via dependency edges?
   * Returns the path [from, ..., to] or null. O(V+E), early exit.
   */
  private _depPath(from: string, to: string): string[] | null {
    const parent = new Map<string, string>();
    const seen = new Set<string>([from]);
    const stack: string[] = [from];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === to) {
        const path: string[] = [node];
        let cur = node;
        while (cur !== from) {
          const p = parent.get(cur)!;
          path.push(p);
          cur = p;
        }
        path.reverse();
        return path;
      }
      const deps = this.depsOf.get(node);
      if (deps) {
        for (const dep of deps) {
          if (!seen.has(dep)) {
            seen.add(dep);
            parent.set(dep, node);
            stack.push(dep);
          }
        }
      }
    }
    return null;
  }
}
