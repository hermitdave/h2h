import { TaskScheduler, Task, TaskStatus, SchedulerError } from '../src/scheduler';

describe('TaskScheduler', () => {
  let scheduler: TaskScheduler;

  beforeEach(() => {
    scheduler = new TaskScheduler();
  });

  describe('Task Addition', () => {
    it('should add a task and return its ID', () => {
      const task: Task = {
        id: 'task-1',
        priority: 5,
        executeAt: Date.now(),
        payload: { action: 'test' },
      };

      const id = scheduler.addTask(task);
      expect(id).toBe('task-1');
    });

    it('should auto-generate ID when not provided', () => {
      const task: Task = {
        priority: 5,
        executeAt: Date.now(),
        payload: { action: 'test' },
      };

      const id = scheduler.addTask(task);
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('should store task with correct properties', () => {
      const task: Task = {
        id: 'task-1',
        priority: 10,
        executeAt: Date.now() + 1000,
        payload: { action: 'test' },
        dependencies: [],
      };

      scheduler.addTask(task);
      const retrieved = scheduler.getTask('task-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.priority).toBe(10);
      expect(retrieved!.payload).toEqual({ action: 'test' });
    });

    it('should reject duplicate task IDs', () => {
      const task: Task = {
        id: 'task-1',
        priority: 5,
        executeAt: Date.now(),
        payload: {},
      };

      scheduler.addTask(task);
      expect(() => scheduler.addTask(task)).toThrow(SchedulerError);
    });
  });

  describe('Priority Queue Behavior', () => {
    it('should return highest priority task first', () => {
      scheduler.addTask({ id: 'low', priority: 1, executeAt: Date.now(), payload: {} });
      scheduler.addTask({ id: 'high', priority: 100, executeAt: Date.now(), payload: {} });
      scheduler.addTask({ id: 'mid', priority: 50, executeAt: Date.now(), payload: {} });

      const first = scheduler.getNextExecutableTask();
      expect(first!.id).toBe('high');

      // getNextExecutableTask does not consume - returns highest priority each time
      const second = scheduler.getNextExecutableTask();
      expect(second!.id).toBe('high');

      // Complete the high priority task to get the next
      scheduler.completeTask('high');
      const third = scheduler.getNextExecutableTask();
      expect(third!.id).toBe('mid');
    });

    it('should respect execution timestamp when priorities are equal', () => {
      const now = Date.now();
      const earlier = now;
      const later = now + 1000;
      
      scheduler.addTask({ id: 'later', priority: 5, executeAt: later, payload: {} });
      scheduler.addTask({ id: 'earlier', priority: 5, executeAt: earlier, payload: {} });

      const first = scheduler.getNextExecutableTask();
      expect(first!.id).toBe('earlier');
    });

    it('should skip tasks not yet due', () => {
      const future = Date.now() + 10000;
      scheduler.addTask({ id: 'future-high', priority: 100, executeAt: future, payload: {} });
      scheduler.addTask({ id: 'now-low', priority: 1, executeAt: Date.now(), payload: {} });

      const result = scheduler.getNextExecutableTask();
      expect(result!.id).toBe('now-low');
    });
  });

  describe('Dependency Tracking', () => {
    it('should not return task with unsatisfied dependencies', () => {
      scheduler.addTask({ id: 'dep', priority: 10, executeAt: Date.now(), payload: {} });
      scheduler.addTask({
        id: 'dependent',
        priority: 100,
        executeAt: Date.now(),
        payload: {},
        dependencies: ['dep'],
      });

      const result = scheduler.getNextExecutableTask();
      expect(result!.id).toBe('dep');
    });

    it('should return dependent task after dependency completes', () => {
      scheduler.addTask({ id: 'dep', priority: 10, executeAt: Date.now(), payload: {} });
      scheduler.addTask({
        id: 'dependent',
        priority: 100,
        executeAt: Date.now(),
        payload: {},
        dependencies: ['dep'],
      });

      scheduler.completeTask('dep');
      const result = scheduler.getNextExecutableTask();
      expect(result!.id).toBe('dependent');
    });

    it('should detect cycles in dependencies', () => {
      scheduler.addTask({ id: 'a', priority: 1, executeAt: Date.now(), payload: {} });
      scheduler.addTask({ id: 'b', priority: 1, executeAt: Date.now(), payload: {}, dependencies: ['a'] });
      scheduler.addTask({ id: 'c', priority: 1, executeAt: Date.now(), payload: {}, dependencies: ['b'] });

      expect(() =>
        scheduler.addTask({ id: 'a', priority: 1, executeAt: Date.now(), payload: {}, dependencies: ['c'] })
      ).toThrow(SchedulerError);
    });

    it('should detect self-dependency', () => {
      expect(() =>
        scheduler.addTask({ id: 'self', priority: 1, executeAt: Date.now(), payload: {}, dependencies: ['self'] })
      ).toThrow(SchedulerError);
    });

    it('should handle multiple dependencies', () => {
      scheduler.addTask({ id: 'dep1', priority: 10, executeAt: Date.now(), payload: {} });
      scheduler.addTask({ id: 'dep2', priority: 20, executeAt: Date.now(), payload: {} });
      scheduler.addTask({
        id: 'dependent',
        priority: 100,
        executeAt: Date.now(),
        payload: {},
        dependencies: ['dep1', 'dep2'],
      });

      scheduler.completeTask('dep1');
      expect(scheduler.getNextExecutableTask()?.id).toBe('dep2');

      scheduler.completeTask('dep2');
      expect(scheduler.getNextExecutableTask()?.id).toBe('dependent');
    });
  });

  describe('Dynamic Updates', () => {
    it('should allow priority updates', () => {
      scheduler.addTask({ id: 't1', priority: 1, executeAt: Date.now(), payload: {} });
      scheduler.addTask({ id: 't2', priority: 10, executeAt: Date.now(), payload: {} });

      scheduler.updateTaskPriority('t1', 100);
      const result = scheduler.getNextExecutableTask();
      expect(result!.id).toBe('t1');
    });

    it('should allow timestamp updates', () => {
      const now = Date.now();
      scheduler.addTask({ id: 't1', priority: 5, executeAt: now + 1000, payload: {} });
      scheduler.addTask({ id: 't2', priority: 5, executeAt: now + 2000, payload: {} });

      scheduler.updateTaskTimestamp('t1', now);
      const result = scheduler.getNextExecutableTask();
      expect(result!.id).toBe('t1');
    });

    it('should allow adding dependencies dynamically', () => {
      scheduler.addTask({ id: 'dep', priority: 10, executeAt: Date.now(), payload: {} });
      scheduler.addTask({ id: 'task', priority: 100, executeAt: Date.now(), payload: {} });

      scheduler.addDependency('task', 'dep');
      scheduler.completeTask('dep');
      expect(scheduler.getNextExecutableTask()?.id).toBe('task');
    });

    it('should allow removing dependencies', () => {
      scheduler.addTask({ id: 'dep', priority: 10, executeAt: Date.now(), payload: {} });
      scheduler.addTask({
        id: 'task',
        priority: 100,
        executeAt: Date.now(),
        payload: {},
        dependencies: ['dep'],
      });

      scheduler.removeDependency('task', 'dep');
      expect(scheduler.getNextExecutableTask()?.id).toBe('task');
    });

    it('should update task payload', () => {
      scheduler.addTask({ id: 't1', priority: 5, executeAt: Date.now(), payload: { x: 1 } });
      scheduler.updateTaskPayload('t1', { x: 2 });
      expect(scheduler.getTask('t1')!.payload).toEqual({ x: 2 });
    });
  });

  describe('Task Completion', () => {
    it('should mark task as completed', () => {
      const task: Task = { id: 't1', priority: 5, executeAt: Date.now(), payload: {} };
      scheduler.addTask(task);
      scheduler.completeTask('t1');

      const updated = scheduler.getTask('t1');
      expect(updated!.status).toBe(TaskStatus.Completed);
    });

    it('should fail to complete non-existent task', () => {
      expect(() => scheduler.completeTask('nonexistent')).toThrow(SchedulerError);
    });

    it('should trigger dependent tasks after completion', () => {
      scheduler.addTask({ id: 'dep', priority: 10, executeAt: Date.now(), payload: {} });
      scheduler.addTask({
        id: 'child',
        priority: 100,
        executeAt: Date.now(),
        payload: {},
        dependencies: ['dep'],
      });

      scheduler.completeTask('dep');
      expect(scheduler.getNextExecutableTask()?.id).toBe('child');
    });
  });

  describe('Task Removal', () => {
    it('should remove a task', () => {
      scheduler.addTask({ id: 't1', priority: 5, executeAt: Date.now(), payload: {} });
      scheduler.removeTask('t1');
      expect(scheduler.getTask('t1')).toBeUndefined();
    });

    it('should update dependents when removing a dependency', () => {
      scheduler.addTask({ id: 'dep', priority: 10, executeAt: Date.now(), payload: {} });
      scheduler.addTask({
        id: 'child',
        priority: 100,
        executeAt: Date.now(),
        payload: {},
        dependencies: ['dep'],
      });

      scheduler.removeTask('dep');
      expect(scheduler.getNextExecutableTask()?.id).toBe('child');
    });

    it('should fail to remove non-existent task', () => {
      expect(() => scheduler.removeTask('nonexistent')).toThrow(SchedulerError);
    });
  });

  describe('Scheduling Statistics', () => {
    it('should return correct counts', () => {
      scheduler.addTask({ id: 't1', priority: 5, executeAt: Date.now(), payload: {} });
      scheduler.addTask({ id: 't2', priority: 5, executeAt: Date.now() + 1000, payload: {} });

      const stats = scheduler.getStats();
      expect(stats.total).toBe(2);
      expect(stats.pending).toBe(2);
      expect(stats.completed).toBe(0);
    });

    it('should update stats after completion', () => {
      scheduler.addTask({ id: 't1', priority: 5, executeAt: Date.now(), payload: {} });
      scheduler.completeTask('t1');

      const stats = scheduler.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.completed).toBe(1);
    });
  });

  describe('Large Scale Performance', () => {
    it('should handle 1 million tasks', () => {
      const count = 1_000_000;
      const start = Date.now();

      for (let i = 0; i < count; i++) {
        scheduler.addTask({
          id: `task-${i}`,
          priority: i % 100,
          executeAt: Date.now(),
          payload: { index: i },
        });
      }

      const addTime = Date.now() - start;
      expect(scheduler.getStats().total).toBe(count);
      console.log(`Added ${count} tasks in ${addTime}ms`);

      const nextStart = Date.now();
      const first = scheduler.getNextExecutableTask();
      const nextTime = Date.now() - nextStart;
      expect(first).toBeDefined();
      console.log(`First retrieval in ${nextTime}ms`);
    });

    it('should handle priority updates for 100k tasks', () => {
      const count = 100_000;
      for (let i = 0; i < count; i++) {
        scheduler.addTask({
          id: `task-${i}`,
          priority: i,
          executeAt: Date.now(),
          payload: {},
        });
      }

      const start = Date.now();
      for (let i = 0; i < count; i++) {
        scheduler.updateTaskPriority(`task-${i}`, count - i);
      }
      const updateTime = Date.now() - start;
      console.log(`Updated ${count} priorities in ${updateTime}ms`);

      const first = scheduler.getNextExecutableTask();
      expect(first?.id).toBe('task-0');
    });
  });

  describe('Edge Cases', () => {
    it('should return null when no executable tasks', () => {
      scheduler.addTask({ id: 'future', priority: 5, executeAt: Date.now() + 10000, payload: {} });
      expect(scheduler.getNextExecutableTask()).toBeNull();
    });

    it('should handle empty scheduler', () => {
      expect(scheduler.getNextExecutableTask()).toBeNull();
      expect(scheduler.getStats().total).toBe(0);
    });

    it('should handle tasks with no dependencies', () => {
      scheduler.addTask({ id: 'free', priority: 5, executeAt: Date.now(), payload: {} });
      expect(scheduler.getNextExecutableTask()?.id).toBe('free');
    });

    it('should handle tasks executing at exact now', () => {
      const task: Task = { id: 'now', priority: 5, executeAt: Date.now(), payload: {} };
      scheduler.addTask(task);
      expect(scheduler.getNextExecutableTask()?.id).toBe('now');
    });
  });
});
