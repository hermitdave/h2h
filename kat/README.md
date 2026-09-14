# In-Memory Task Scheduler

A production-ready, in-memory task scheduler supporting 1M+ tasks with priorities, execution timestamps, dependency tracking, dynamic updates, cycle detection, and efficient retrieval of the next executable task.

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     TaskScheduler                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │   MaxHeap    │  │    Map       │  │  Dependency Graph    │   │
│  │  (Priority)  │◄►│  (Tasks)     │◄►│    (DAG)             │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│        │                 │                     │                │
│        ▼                 ▼                     ▼                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  O(log n)    │  │  O(1)        │  │  O(d) dependency     │   │
│  │  insert/pop  │  │  lookup      │  │  traversal           │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Add Task**: Validate → Create dependency entry → Update parents → Insert into heap
2. **Get Next**: Check heap top → Verify executable → Return or scan
3. **Complete Task**: Mark completed → Notify dependents → Trigger re-evaluation
4. **Update Priority**: Remove from heap → Update → Re-insert
5. **Add Dependency**: Validate cycle → Update both endpoints

## Data Structures

### 1. MaxHeap (Binary Heap)

- **Type**: Array-based max-heap
- **Ordering**: Priority (desc) → ExecuteAt (asc) → CreatedAt (asc)
- **Operations**:
  - `add()`: O(log n) - Insert with sift-up
  - `removeAt()`: O(log n) - Replace with last, sift-down
  - `peek()`: O(1) - Return top element
  - `getAll()`: O(1) - Return array reference

### 2. Task Map

- **Type**: `Map<string, TaskMetadata>`
- **Lookup**: O(1) average case
- **Structure**:
  ```typescript
  interface TaskMetadata {
    task: Task;
    depEntry: DependencyEntry;
  }
  
  interface DependencyEntry {
    dependents: Set<string>;  // Tasks that depend on this
    dependencies: Set<string>; // Tasks this depends on
  }
  ```

### 3. Dependency Graph

- **Type**: Implicit DAG via `DependencyEntry` sets
- **Cycle Detection**: DFS from dependency to check for back-edges
- **Complexity**: O(V + E) where V = tasks, E = dependencies

## Complexity Analysis

| Operation | Time Complexity | Space Complexity | Notes |
|-----------|----------------|------------------|-------|
| `addTask()` | O(log n) | O(1) | Heap insert + map insert |
| `getNextExecutableTask()` | O(n) worst, O(1) best | O(k) | Best: heap top is executable. Worst: scan all |
| `completeTask()` | O(d) | O(1) | d = number of dependents |
| `updateTaskPriority()` | O(log n) | O(1) | Heap remove + insert |
| `updateTaskTimestamp()` | O(log n) | O(1) | Heap remove + insert |
| `addDependency()` | O(V + E) | O(1) | Cycle detection via DFS |
| `removeDependency()` | O(1) | O(1) | Set operations |
| `removeTask()` | O(log n) | O(1) | Heap remove + map delete |
| `getStats()` | O(n) | O(1) | Iterate all tasks |

### Production Performance (1M tasks)

- **Task Addition**: ~1.3s (1M inserts)
- **First Retrieval**: ~550ms (full scan)
- **Priority Updates**: ~10.5s (100K updates, O(log n) each)

## API Reference

### TaskScheduler

```typescript
class TaskScheduler {
  // Add a task to the scheduler
  addTask(task: Task): string;
  
  // Get the next executable task (highest priority, due, dependencies satisfied)
  getNextExecutableTask(): Task | null;
  
  // Mark a task as completed
  completeTask(taskId: string): void;
  
  // Update task priority
  updateTaskPriority(taskId: string, newPriority: number): void;
  
  // Update task execution timestamp
  updateTaskTimestamp(taskId: string, newTimestamp: number): void;
  
  // Add a dependency to an existing task
  addDependency(taskId: string, dependencyId: string): void;
  
  // Remove a dependency from a task
  removeDependency(taskId: string, dependencyId: string): void;
  
  // Update task payload
  updateTaskPayload(taskId: string, newPayload: Record<string, unknown>): void;
  
  // Remove a task from the scheduler
  removeTask(taskId: string): void;
  
  // Get task by ID
  getTask(taskId: string): Task | undefined;
  
  // Get scheduler statistics
  getStats(): { total: number; pending: number; completed: number; failed: number };
}
```

### Task Interface

```typescript
interface Task {
  id?: string;              // Optional, auto-generated if omitted
  priority: number;         // Higher = more important
  executeAt: number;        // Unix timestamp in milliseconds
  payload: Record<string, unknown>;
  dependencies?: string[];  // IDs of prerequisite tasks
  status?: TaskStatus;      // Internal, read-only
  createdAt?: number;       // Internal, auto-set
}
```

### TaskStatus Enum

```typescript
enum TaskStatus {
  Pending = 'pending',
  Completed = 'completed',
  Failed = 'failed'
}
```

### SchedulerError

```typescript
class SchedulerError extends Error {
  code: string;  // 'DUPLICATE_TASK', 'INVALID_DEPENDENCY', 'CYCLE_DETECTED', 'TASK_NOT_FOUND'
}
```

## Edge Cases Handled

1. **Duplicate IDs**: Throws `SchedulerError` with `DUPLICATE_TASK` code
2. **Self-dependency**: Detected and rejected
3. **Cyclic dependencies**: DFS-based cycle detection prevents creation
4. **Invalid dependencies**: Validates dependency exists before adding
5. **Non-existent task operations**: Throws `SchedulerError` with `TASK_NOT_FOUND`
6. **Future tasks**: `getNextExecutableTask()` returns null if no tasks are due
7. **Empty scheduler**: Returns null safely
8. **Concurrent modifications**: Thread-safe within single-threaded JS runtime

## Scalability Discussion

### Current Limitations

1. **getNextExecutableTask()**: O(n) scan in worst case
   - **Mitigation**: Heap top is often executable (O(1) case)
   - **Alternative**: Maintain a separate index of executable tasks

2. **Memory**: ~100MB for 1M tasks (Node.js runtime overhead)
   - Each task: ~100-200 bytes
   - Heap array: ~24MB (1M * 24 bytes per node)
   - Map overhead: ~100MB (JavaScript object overhead)

3. **Cycle Detection**: O(V + E) for complex graphs
   - Acceptable for most workloads
   - Consider Tarjan's algorithm for very large graphs

### Optimization Opportunities

1. **Executable Index**:
   ```typescript
   private executableTasks: Set<string> = new Set();
   
   // Maintain this set on updates/completions
   // getNextExecutableTask() becomes O(log n) heap peek
   ```

2. **Lazy Heap Maintenance**:
   - Don't immediately remove completed tasks
   - Skip them during scan (current approach)

3. **Sharding**:
   - For 10M+ tasks, partition by priority range or dependency clusters
   - Use consistent hashing for task distribution

4. **Persistence**:
   - Add checkpoint/recovery for crash tolerance
   - Serialize heap + map to disk periodically

### Production Recommendations

1. **Monitoring**: Track heap size, map size, scan frequency
2. **Timeouts**: Add timeout to `getNextExecutableTask()` for batch processing
3. **Batch Operations**: Add `addTasks()`, `completeTasks()` for bulk operations
4. **Event System**: Add listeners for task completion, dependency resolution
5. **GC Pressure**: Consider object pooling for high-frequency task creation

## Testing

Run tests:
```bash
npm test
```

Coverage:
```bash
npm test -- --coverage
```

Test categories:
- Task addition and validation
- Priority queue behavior
- Dependency tracking and cycle detection
- Dynamic updates (priority, timestamp, dependencies)
- Task completion and propagation
- Task removal
- Statistics and counting
- Large scale performance (1M tasks)
- Edge cases

## File Structure

```
kat/
├── src/
│   ├── scheduler.ts    # Core implementation
│   └── index.ts        # Public API exports
├── tests/
│   └── scheduler.spec.ts  # Comprehensive test suite
├── package.json
├── tsconfig.json
└── jest.config.js
```
