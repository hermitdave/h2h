export enum TaskStatus {
  PENDING = 'PENDING',
  READY = 'READY',
  EXECUTABLE = 'EXECUTABLE',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface Task {
  id: string;
  payload: unknown;
  priority: number;
  executeTime: number;
  dependencies: string[];
  status: TaskStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface AddTaskInput {
  id: string;
  payload?: unknown;
  priority?: number;
  executeTime?: number;
  dependencies?: string[];
}

export interface TaskUpdates {
  payload?: unknown;
  priority?: number;
  executeTime?: number;
  dependencies?: string[] | null;
}

export interface SchedulerOptions {
  now?: number;
  maxTasks?: number;
}

export interface TaskMetrics {
  total: number;
  pending: number;
  ready: number;
  executable: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  heapSize: number;
}

export interface ITaskScheduler {
  addTask(task: AddTaskInput): Task;
  updateTask(id: string, updates: TaskUpdates): Task;
  deleteTask(id: string): void;
  completeTask(id: string, force?: boolean): Task;
  failTask(id: string): Task;
  cancelTask(id: string): Task;
  executeNextTask(now?: number): Task | null;
  getNextExecutableTask(): Task | null;
  getExecutableTasks(): Task[];
  getPendingTasks(): Task[];
  getReadyTasks(): Task[];
  getTask(id: string): Task | null;
  getAllTasks(): Task[];
  hasCycle(): boolean;
  wouldCreateCycle(taskId: string, dependencyId: string): boolean;
  countByStatus(): Record<string, number>;
  metrics(): TaskMetrics;
  clear(): void;
  setNow(now: number): void;
}