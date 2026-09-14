import { BinaryHeap } from './binary-heap';
import type { Task, AddTaskInput, TaskUpdates, SchedulerOptions, TaskMetrics, ITaskScheduler } from './types';
import { TaskStatus } from './types';

function validateDependencies(dependencies: string[]): void {
  if (!Array.isArray(dependencies)) throw new TypeError('dependencies must be an array');
  for (const dep of dependencies) {
    if (typeof dep !== 'string' || dep.trim() === '') {
      throw new TypeError('each dependency id must be a non-empty string');
    }
  }
}

function normalizeUpdates(updates: TaskUpdates): TaskUpdates {
  if (typeof updates.dependencies === 'string') {
    updates.dependencies = [updates.dependencies];
  }
  return updates;
}

/**
 * Production-grade in-memory task scheduler.
 *
 * Data structures:
 *   - tasks:       Map<id, Task> for O(1) lookups and updates.
 *   - heap:        BinaryHeap over READY tasks ordered by (priority desc, executeTime asc).
 *   - adjacency:   Map<dependencyId, Set<dependentId>> — reverse-graph for unblock propagation.
 *   - depSet:      Map<taskId, Set<dependencyId>> — cache for cycle detection + status checks.
 *
 * Key invariants:
 *   - PENDING -> READY  when all dependencies are COMPLETED.
 *   - READY tasks are inserted into the heap.
 *   - executeNextTask pops tasks from the heap; non-executable ones are
 *     re-pushed so the heap stays consistent.  Executed tasks are marked
 *     COMPLETED so dependents can be unblocked.
 *
 * Hook order for each task execution:
 *   1. onTaskExecute(task)
 *   2. task is marked COMPLETED
 *   3. onTaskComplete(task)
 *   4. dependents are unblocked
 */
export class TaskScheduler implements ITaskScheduler {
  private tasks: Map<string, Task> = new Map();
  private heap: BinaryHeap = new BinaryHeap();
  private adjacency: Map<string, Set<string>> = new Map();
  private depSet: Map<string, Set<string>> = new Map();
  private now: number;
  private maxTasks: number;

  // Public hooks.
  onTaskExecute?: (task: Task) => void;
  onTaskComplete?: (task: Task) => void;

  constructor(options?: SchedulerOptions) {
    this.now = options?.now ?? Date.now();
    this.maxTasks = options?.maxTasks ?? 0;
  }

  setNow(now: number): void {
    this.now = now;
  }

  // ------------------------------------------------------------------ //
  //  Task CRUD
  // ------------------------------------------------------------------ //

  addTask(task: AddTaskInput): Task {
    if (typeof task.id !== 'string' || task.id.trim() === '') {
      throw new TypeError('task id must be a non-empty string');
    }
    if (task.dependencies) validateDependencies(task.dependencies);

    if (this.maxTasks && this.tasks.size >= this.maxTasks) {
      throw new Error('scheduler has reached its maximum task capacity');
    }
    if (this.tasks.has(task.id)) {
      throw new Error(`task with id '${task.id}' already exists`);
    }

    const ts = this.now;
    const entry: Task = {
      id: task.id,
      payload: task.payload ?? null,
      priority: typeof task.priority === 'number' ? task.priority : 0,
      executeTime: typeof task.executeTime === 'number' ? task.executeTime : ts,
      dependencies: task.dependencies ?? [],
      status: TaskStatus.PENDING,
      version: 0,
      createdAt: ts,
      updatedAt: ts,
    };

    this.tasks.set(entry.id, entry);
    this.depSet.set(entry.id, new Set(entry.dependencies));
    this._registerDeps(entry.id, entry.dependencies);

    this._reconcileStatus(entry);
    return entry;
  }

  updateTask(id: string, updates: TaskUpdates): Task {
    const entry = this.tasks.get(id);
    if (!entry) throw new Error(`task '${id}' not found`);

    const u = normalizeUpdates(updates);
    const wasReady = entry.status === TaskStatus.READY;
    const wasPending = entry.status === TaskStatus.PENDING;
    const oldDeps = [...entry.dependencies];

    if (u.payload !== undefined) entry.payload = u.payload;
    if (u.priority !== undefined) entry.priority = u.priority;
    if (u.executeTime !== undefined) entry.executeTime = u.executeTime;
    if (u.dependencies !== undefined) {
      if (u.dependencies === null) {
        entry.dependencies = [];
        this.depSet.set(id, new Set());
      } else {
        validateDependencies(u.dependencies);
        entry.dependencies = [...u.dependencies];
        this.depSet.set(id, new Set(u.dependencies));
      }
      // Update adjacency: remove from old dep lists, add to new dep lists.
      this._unregisterDeps(id, oldDeps);
      this._registerDeps(id, entry.dependencies);
    }
    entry.version++;
    entry.updatedAt = this.now;

    if (wasPending && this._dependenciesMet(entry)) {
      this._markReady(entry);
    } else if (wasReady) {
      // Was READY — refresh heap ordering (priority / executeTime change).
      this.heap.remove(id);
      this.heap.push(entry);
    }
    return entry;
  }

  deleteTask(id: string): void {
    const entry = this.tasks.get(id);
    if (!entry) throw new Error(`task '${id}' not found`);

    this.heap.remove(id);
    this.tasks.delete(id);
    this.depSet.delete(id);
    this._unregisterDeps(id, entry.dependencies);

    // Dependents retain their depSet entries for the deleted task, but
    // since the task no longer exists, they remain blocked.
    this._cleanupAdjacency(id);
  }

  completeTask(id: string, force: boolean = false): Task {
    const entry = this.tasks.get(id);
    if (!entry) throw new Error(`task '${id}' not found`);

    if (!force && entry.status === TaskStatus.COMPLETED) {
      return entry;
    }
    if (!force && (entry.status === TaskStatus.CANCELLED || entry.status === TaskStatus.FAILED)) {
      throw new Error(`cannot complete a ${entry.status} task`);
    }

    entry.status = TaskStatus.COMPLETED;
    entry.updatedAt = this.now;
    this.heap.remove(id);
    this._unblockDependents(id);
    return entry;
  }

  failTask(id: string): Task {
    const entry = this.tasks.get(id);
    if (!entry) throw new Error(`task '${id}' not found`);
    entry.status = TaskStatus.FAILED;
    entry.updatedAt = this.now;
    this.heap.remove(id);
    return entry;
  }

  cancelTask(id: string): Task {
    const entry = this.tasks.get(id);
    if (!entry) throw new Error(`task '${id}' not found`);
    if (entry.status === TaskStatus.COMPLETED) {
      throw new Error('cannot cancel a completed task');
    }
    entry.status = TaskStatus.CANCELLED;
    entry.updatedAt = this.now;
    this.heap.remove(id);
    return entry;
  }

  // ------------------------------------------------------------------ //
  //  Executable retrieval
  // ------------------------------------------------------------------ //

  getNextExecutableTask(): Task | null {
    return this.executeNextTask(this.now);
  }

  executeNextTask(now?: number): Task | null {
    if (now !== undefined) this.now = now;

    if (this.heap.length === 0) {
      return null;
    }

    const collected: Task[] = [];
    let found: Task | null = null;

    while (collected.length < this.heap.length + 1) {
      const top = this.heap.pop();
      if (!top) break;

      const current = this.tasks.get(top.id);
      if (!current) {
        continue;
      }

      if (
        current.status === TaskStatus.READY &&
        this._dependenciesMet(current) &&
        current.executeTime <= this.now
      ) {
        found = current;
        break;
      }

      collected.push(current);
    }

    if (found) {
      // 1. onTaskExecute hook
      this.onTaskExecute?.(found);
      // 2. mark COMPLETED
      found.status = TaskStatus.COMPLETED;
      // 3. onTaskComplete hook
      this.onTaskComplete?.(found);
      // 4. unblock dependents
      this._unblockDependents(found.id);
      // Re-push collected (non-executable / future) tasks.
      for (const t of collected) {
        this.heap.push(t);
      }
      return found;
    }

    for (const t of collected) {
      this.heap.push(t);
    }
    return null;
  }

  getExecutableTasks(): Task[] {
    const result: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === TaskStatus.READY || t.status === TaskStatus.EXECUTABLE) {
        if (this._dependenciesMet(t) && t.executeTime <= this.now) {
          result.push(t);
        }
      }
    }
    return result;
  }

  getPendingTasks(): Task[] {
    const result: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === TaskStatus.PENDING) {
        result.push(t);
      }
    }
    return result;
  }

  getReadyTasks(): Task[] {
    this._buildHeapIfEmpty();
    const result: Task[] = [];
    const snapshot = this.heap.toArray();
    for (const t of snapshot) {
      const current = this.tasks.get(t.id);
      if (!current) continue;
      if (current.status === TaskStatus.READY) {
        result.push(current);
      }
    }
    return result;
  }

  getCompletedTasks(): Task[] {
    const result: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === TaskStatus.COMPLETED) result.push(t);
    }
    return result;
  }

  getTask(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  // ------------------------------------------------------------------ //
  //  Cycle detection
  // ------------------------------------------------------------------ //

  hasCycle(): boolean {
    return this._detectCycle();
  }

  wouldCreateCycle(taskId: string, dependencyId: string): boolean {
    if (taskId === dependencyId) return true;
    const visited = new Set<string>();
    const stack: string[] = [dependencyId];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === taskId) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      const deps = this.depSet.get(node);
      if (deps) {
        for (const d of deps) stack.push(d);
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ //
  //  Status transitions & heap management
  // ------------------------------------------------------------------ //

  private _reconcileStatus(task: Task): void {
    if (task.status === TaskStatus.PENDING) {
      if (this._dependenciesMet(task)) {
        this._markReady(task);
      }
    }
  }

  private _markReady(task: Task): void {
    if (task.status === TaskStatus.PENDING) {
      task.status = TaskStatus.READY;
      task.updatedAt = this.now;
      this.heap.push(task);
    }
  }

  private _dependenciesMet(task: Task): boolean {
    if (task.dependencies.length === 0) return true;
    const deps = this.depSet.get(task.id);
    if (!deps) return true;
    for (const dep of deps) {
      const t = this.tasks.get(dep);
      if (!t || t.status !== TaskStatus.COMPLETED) return false;
    }
    return true;
  }

  private _unblockDependents(taskId: string): void {
    const dependents = this.adjacency.get(taskId);
    if (!dependents) return;
    for (const dep of dependents) {
      const child = this.tasks.get(dep);
      if (!child) continue;
      if (child.status !== TaskStatus.PENDING) continue;
      if (this._dependenciesMet(child)) {
        this._markReady(child);
      }
    }
  }

  private _refreshHeap(): void {
    const ready = this._snapshotReadyTasks();
    this.heap.clear();
    this.heap.heapify(ready);
  }

  private _buildHeapIfEmpty(): void {
    if (this.heap.length === 0) {
      this._refreshHeap();
    }
  }

  private _snapshotReadyTasks(): Task[] {
    const result: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === TaskStatus.READY) {
        result.push(t);
      }
    }
    return result;
  }

  // ------------------------------------------------------------------ //
  //  Adjacency helpers
  // ------------------------------------------------------------------ //

  private _registerDeps(taskId: string, deps: string[]): void {
    for (const dep of deps) {
      const set = this.adjacency.get(dep);
      if (set) set.add(taskId);
      else this.adjacency.set(dep, new Set([taskId]));
    }
  }

  private _unregisterDeps(taskId: string, deps: string[]): void {
    for (const dep of deps) {
      const set = this.adjacency.get(dep);
      if (set) {
        set.delete(taskId);
        if (set.size === 0) this.adjacency.delete(dep);
      }
    }
  }

  private _cleanupAdjacency(taskId: string): void {
    for (const set of this.adjacency.values()) {
      set.delete(taskId);
    }
    for (const [key, set] of this.adjacency.entries()) {
      if (set.size === 0) this.adjacency.delete(key);
    }
  }

  // ------------------------------------------------------------------ //
  //  Metrics
  // ------------------------------------------------------------------ //

  countByStatus(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const t of this.tasks.values()) {
      counts[t.status] = (counts[t.status] || 0) + 1;
    }
    return counts;
  }

  metrics(): TaskMetrics {
    const counts = this.countByStatus();
    return {
      total: this.tasks.size,
      pending: counts[TaskStatus.PENDING] || 0,
      ready: counts[TaskStatus.READY] || 0,
      executable: this.getExecutableTasks().length,
      running: counts[TaskStatus.RUNNING] || 0,
      completed: counts[TaskStatus.COMPLETED] || 0,
      failed: counts[TaskStatus.FAILED] || 0,
      cancelled: counts[TaskStatus.CANCELLED] || 0,
      heapSize: this.heap.length,
    };
  }

  clear(): void {
    this.tasks.clear();
    this.heap.clear();
    this.adjacency.clear();
    this.depSet.clear();
  }

  // ------------------------------------------------------------------ //
  //  Internal: cycle detection via iterative DFS over depSet
  // ------------------------------------------------------------------ //

  private _detectCycle(): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (node: string): boolean => {
      if (inStack.has(node)) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      inStack.add(node);
      const deps = this.depSet.get(node);
      if (deps) {
        for (const d of deps) {
          if (dfs(d)) return true;
        }
      }
      inStack.delete(node);
      return false;
    };

    for (const node of this.tasks.keys()) {
      if (!visited.has(node)) {
        if (dfs(node)) return true;
      }
    }
    return false;
  }
}