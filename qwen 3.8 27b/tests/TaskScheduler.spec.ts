import {
  TaskScheduler,
  TaskStatus,
  CycleError,
  DuplicateTaskError,
  CapacityExceededError,
  InvalidTaskError,
  TaskNotFoundError,
  StaleVersionError,
  type Task,
} from '../src';

const NOW = 1_000_000;

function make(opts: ConstructorParameters<typeof TaskScheduler>[0] = {}): TaskScheduler {
  return new TaskScheduler({ now: NOW, ...opts });
}

function ids(tasks: Array<Task | null>): string[] {
  return tasks.filter((t): t is Task => t !== null).map((t) => t.id);
}

describe('TaskScheduler — addTask', () => {
  test('creates a task with defaults: priority 0, executeTime = clock, READY', () => {
    const s = make();
    const t = s.addTask({ id: 'a' });
    expect(t.priority).toBe(0);
    expect(t.executeTime).toBe(NOW);
    expect(t.status).toBe(TaskStatus.READY);
    expect(t.unmetDependencies).toBe(0);
    expect(t.version).toBe(0);
    expect(t.dependencies).toEqual([]);
    expect(t.payload).toBeNull();
  });

  test('duplicate id throws DuplicateTaskError', () => {
    const s = make();
    s.addTask({ id: 'a' });
    expect(() => s.addTask({ id: 'a' })).toThrow(DuplicateTaskError);
  });

  test('empty / whitespace id throws InvalidTaskError', () => {
    const s = make();
    expect(() => s.addTask({ id: '' })).toThrow(InvalidTaskError);
    expect(() => s.addTask({ id: '   ' })).toThrow(InvalidTaskError);
  });

  test('non-finite priority / executeTime throws', () => {
    const s = make();
    expect(() => s.addTask({ id: 'a', priority: Number.NaN })).toThrow(InvalidTaskError);
    expect(() => s.addTask({ id: 'b', priority: Infinity })).toThrow(InvalidTaskError);
    expect(() => s.addTask({ id: 'c', executeTime: Number.NaN })).toThrow(InvalidTaskError);
  });

  test('unknown dependency throws (no forward references)', () => {
    const s = make();
    expect(() => s.addTask({ id: 'a', dependencies: ['ghost'] })).toThrow(InvalidTaskError);
  });

  test('self dependency throws CycleError', () => {
    const s = make();
    expect(() => s.addTask({ id: 'a', dependencies: ['a'] })).toThrow(CycleError);
  });

  test('duplicate dependencies are deduplicated', () => {
    const s = make();
    s.addTask({ id: 'dep' });
    const t = s.addTask({ id: 'a', dependencies: ['dep', 'dep', 'dep'] });
    expect(t.dependencies).toEqual(['dep']);
    expect(t.unmetDependencies).toBe(1);
  });

  test('capacity limit is enforced', () => {
    const s = make({ maxTasks: 2 });
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    expect(() => s.addTask({ id: 'c' })).toThrow(CapacityExceededError);
  });

  test('task whose deps are already COMPLETED starts READY', () => {
    const s = make();
    s.addTask({ id: 'dep' });
    s.completeTask('dep');
    const t = s.addTask({ id: 'a', dependencies: ['dep'] });
    expect(t.status).toBe(TaskStatus.READY);
    expect(t.unmetDependencies).toBe(0);
  });

  test('task with uncompleted deps starts PENDING and unblocked deps stay counted', () => {
    const s = make();
    s.addTask({ id: 'd1' });
    s.addTask({ id: 'd2' });
    s.completeTask('d1');
    const t = s.addTask({ id: 'a', dependencies: ['d1', 'd2'] });
    expect(t.status).toBe(TaskStatus.PENDING);
    expect(t.unmetDependencies).toBe(1);
  });
});

describe('TaskScheduler — priority and time ordering', () => {
  test('claims highest priority first among due tasks', () => {
    const s = make();
    s.addTask({ id: 'low', priority: 1 });
    s.addTask({ id: 'mid', priority: 50 });
    s.addTask({ id: 'high', priority: 99 });
    expect(ids([s.claimNextExecutable()])).toEqual(['high']);
    expect(ids([s.claimNextExecutable()])).toEqual(['mid']);
    expect(ids([s.claimNextExecutable()])).toEqual(['low']);
  });

  test('equal priority: earlier executeTime first', () => {
    const s = make();
    s.addTask({ id: 'late', priority: 5, executeTime: NOW + 500 });
    s.addTask({ id: 'early', priority: 5, executeTime: NOW + 100 });
    expect(s.peekNextExecutable(NOW + 100)!.id).toBe('early');
    s.claimNextExecutable(NOW + 100);
    expect(s.peekNextExecutable(NOW + 500)!.id).toBe('late');
  });

  test('equal priority + time: FIFO by creation sequence', () => {
    const s = make();
    s.addTask({ id: 'first' });
    s.addTask({ id: 'second' });
    s.addTask({ id: 'third' });
    expect(ids([s.claimNextExecutable()])).toEqual(['first']);
    expect(ids([s.claimNextExecutable()])).toEqual(['second']);
    expect(ids([s.claimNextExecutable()])).toEqual(['third']);
  });

  test('future task is not claimable until its executeTime passes', () => {
    const s = make();
    s.addTask({ id: 'now' });
    s.addTask({ id: 'later', priority: 1000, executeTime: NOW + 10_000 });
    expect(s.claimNextExecutable()!.id).toBe('now'); // later is high priority but not due
    expect(s.claimNextExecutable()).toBeNull();
    expect(s.claimNextExecutable(NOW + 10_000)!.id).toBe('later');
  });

  test('due low-priority task beats high-priority future task', () => {
    const s = make();
    s.addTask({ id: 'due-low', priority: 1 });
    s.addTask({ id: 'future-high', priority: 1000, executeTime: NOW + 999_999 });
    expect(s.claimNextExecutable()!.id).toBe('due-low');
    expect(s.claimNextExecutable()).toBeNull();
    expect(s.claimNextExecutable(NOW + 999_999)!.id).toBe('future-high');
  });

  test('nextWakeTime: due → clock; only-future → that time; empty → null', () => {
    const s1 = make();
    s1.addTask({ id: 'a' });
    expect(s1.nextWakeTime()).toBe(NOW);

    const s2 = make();
    s2.addTask({ id: 'a', executeTime: NOW + 42 });
    expect(s2.nextWakeTime()).toBe(NOW + 42);

    const s3 = make();
    expect(s3.nextWakeTime()).toBeNull();
  });

  test('clock advances only forward; a backward now is ignored', () => {
    const s = make();
    s.addTask({ id: 'a', executeTime: NOW + 4000 });
    expect(s.peekNextExecutable(NOW + 5000)!.id).toBe('a'); // clock now NOW+5000
    // Caller passes a stale (older) time: it must be ignored, not applied.
    const peek = s.peekNextExecutable(NOW);
    expect(s.metrics().clockRegressionsIgnored).toBe(1);
    expect(peek!.id).toBe('a'); // still claimable: 4000 <= 5000
    expect(s.claimNextExecutable()!.id).toBe('a');
  });
});

describe('TaskScheduler — dependencies', () => {
  test('chain: A → B → C executes in dependency order', () => {
    const s = make();
    s.addTask({ id: 'A' });
    s.addTask({ id: 'B', dependencies: ['A'] });
    s.addTask({ id: 'C', dependencies: ['B'] });
    expect(s.claimNextExecutable()!.id).toBe('A');
    s.completeTask('A');
    expect(s.claimNextExecutable()!.id).toBe('B');
    s.completeTask('B');
    expect(s.claimNextExecutable()!.id).toBe('C');
    s.completeTask('C');
    expect(s.claimNextExecutable()).toBeNull();
  });

  test('diamond: dependent unblocks only after BOTH branches complete', () => {
    const s = make();
    s.addTask({ id: 'A' });
    s.addTask({ id: 'B', dependencies: ['A'] });
    s.addTask({ id: 'C', dependencies: ['A'] });
    s.addTask({ id: 'D', dependencies: ['B', 'C'] });
    s.completeTask('A');
    const ready = s.getReadyTasks().map((t) => t.id).sort();
    expect(ready).toEqual(['B', 'C']);
    s.completeTask('B');
    expect(s.claimNextExecutable()!.id).toBe('C');
    s.completeTask('C');
    // D unblocked exactly once, now claimable
    expect(s.claimNextExecutable()!.id).toBe('D');
  });

  test('shared dep unblocks all dependents', () => {
    const s = make();
    s.addTask({ id: 'A' });
    s.addTask({ id: 'B', dependencies: ['A'] });
    s.addTask({ id: 'C', dependencies: ['A'] });
    s.addTask({ id: 'D', dependencies: ['A'] });
    s.completeTask('A');
    expect(s.getReadyTasks().length).toBe(3);
  });

  test('fan-in: 100 deps — unblocks on the last one', () => {
    const s = make();
    const deps: string[] = [];
    for (let i = 0; i < 100; i++) {
      deps.push(`d${i}`);
      s.addTask({ id: `d${i}`, priority: 0 });
    }
    s.addTask({ id: 'big', dependencies: deps });
    expect(s.claimNextExecutable()!.id).toBe('d0');
    for (let i = 0; i < 99; i++) {
      s.completeTask(`d${i}`);
      const big = s.getTask('big')!;
      expect(big.status).toBe(TaskStatus.PENDING);
      expect(big.unmetDependencies).toBe(100 - i - 1);
    }
    s.completeTask('d99');
    expect(s.getTask('big')!.status).toBe(TaskStatus.READY);
  });

  test('fan-out: completing one dep unblocks 1000 dependents', () => {
    const s = make();
    s.addTask({ id: 'root' });
    for (let i = 0; i < 1000; i++) {
      s.addTask({ id: `k${i}`, dependencies: ['root'] });
    }
    s.completeTask('root');
    expect(s.getReadyTasks().length).toBe(1000);
  });

  test('completed dep then re-blocked via dependency update', () => {
    const s = make();
    s.addTask({ id: 'done' });
    s.completeTask('done');
    s.addTask({ id: 'waiting', dependencies: ['done'] });
    expect(s.getTask('waiting')!.status).toBe(TaskStatus.READY);
    s.addTask({ id: 'notdone' });
    s.updateTask('waiting', { dependencies: ['done', 'notdone'] });
    expect(s.getTask('waiting')!.status).toBe(TaskStatus.PENDING);
    expect(s.claimNextExecutable()!.id).toBe('notdone');
    s.completeTask('notdone');
    expect(s.claimNextExecutable()!.id).toBe('waiting');
  });
});

describe('TaskScheduler — claim / complete / fail / cancel lifecycle', () => {
  test('claim marks RUNNING; complete finalizes and unblocks', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    const claimed = s.claimNextExecutable()!;
    expect(claimed.id).toBe('a');
    expect(claimed.status).toBe(TaskStatus.RUNNING);
    s.completeTask('a');
    expect(s.getTask('a')!.status).toBe(TaskStatus.COMPLETED);
    expect(s.claimNextExecutable()!.id).toBe('b');
  });

  test('completeTask is idempotent from COMPLETED', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.completeTask('a');
    const before = s.metrics().completed;
    s.completeTask('a');
    expect(s.metrics().completed).toBe(before);
  });

  test('completeTask throws from FAILED / CANCELLED', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.failTask('a');
    s.cancelTask('b');
    expect(() => s.completeTask('a')).toThrow(InvalidTaskError);
    expect(() => s.completeTask('b')).toThrow(InvalidTaskError);
  });

  test('force-completing a PENDING task unblocks dependents', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    s.completeTask('a'); // a was never READY
    expect(s.claimNextExecutable()!.id).toBe('b');
  });

  test('failTask leaves dependents blocked', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    const err = new Error('boom');
    s.claimNextExecutable();
    s.failTask('a', err);
    expect(s.getTask('a')!.failureReason).toBe(err);
    expect(s.getTask('b')!.status).toBe(TaskStatus.PENDING);
    const blocked = s.getBlockedTasks();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.task.id).toBe('b');
    expect(blocked[0]!.missing).toEqual(['a']);
  });

  test('failTask is idempotent from FAILED, throws from COMPLETED', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.failTask('a', 'x');
    s.failTask('a', 'y');
    expect(s.getTask('a')!.failureReason).toBe('x');
    s.completeTask('b');
    expect(() => s.failTask('b')).toThrow(InvalidTaskError);
  });

  test('cancelTask blocks dependents; terminal no-op', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    s.cancelTask('a');
    expect(s.getTask('a')!.status).toBe(TaskStatus.CANCELLED);
    expect(s.getTask('b')!.status).toBe(TaskStatus.PENDING);
    s.cancelTask('a'); // no-op
    expect(s.getTask('a')!.status).toBe(TaskStatus.CANCELLED);
  });

  test('cancelling a RUNNING task is allowed (abandon)', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.claimNextExecutable();
    s.cancelTask('a');
    expect(s.getTask('a')!.status).toBe(TaskStatus.CANCELLED);
  });

  test('hooks fire in order: claimed → completed', () => {
    const events: string[] = [];
    const s = new TaskScheduler({
      now: NOW,
      onTaskClaimed: (t) => events.push(`claim:${t.id}`),
      onTaskCompleted: (t) => events.push(`complete:${t.id}`),
      onTaskFailed: (t) => events.push(`fail:${t.id}`),
    });
    s.addTask({ id: 'a' });
    s.claimNextExecutable();
    s.completeTask('a');
    s.addTask({ id: 'b' });
    const b = s.claimNextExecutable()!;
    s.failTask(b.id);
    expect(events).toEqual(['claim:a', 'complete:a', 'claim:b', 'fail:b']);
  });

  test('executeNextTask runs the executor, completes on success', async () => {
    const s = make();
    s.addTask({ id: 'a', payload: 21 });
    const ran: number[] = [];
    const t = await s.executeNextTask((task) => {
      ran.push(task.payload as number);
    });
    expect(t!.id).toBe('a');
    expect(ran).toEqual([21]);
    expect(s.getTask('a')!.status).toBe(TaskStatus.COMPLETED);
  });

  test('executeNextTask fails the task and rethrows on executor error', async () => {
    const s = make();
    s.addTask({ id: 'a' });
    const boom = new Error('kaboom');
    await expect(
      s.executeNextTask(() => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(s.getTask('a')!.status).toBe(TaskStatus.FAILED);
    expect(s.getTask('a')!.failureReason).toBe(boom);
  });

  test('executeNextTask with async executor keeps task RUNNING in between', async () => {
    const s = make();
    s.addTask({ id: 'a' });
    let observed: string | null = null;
    await s.executeNextTask(async () => {
      observed = s.getTask('a')!.status;
    });
    expect(observed).toBe(TaskStatus.RUNNING);
    expect(s.getTask('a')!.status).toBe(TaskStatus.COMPLETED);
  });

  test('executeNextTask returns null when nothing is executable', async () => {
    const s = make();
    const t = await s.executeNextTask(() => 1);
    expect(t).toBeNull();
  });

  test('claiming is impossible twice: second claim skips the RUNNING task', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    expect(s.claimNextExecutable()!.id).toBe('a');
    expect(s.claimNextExecutable()!.id).toBe('b');
    expect(s.claimNextExecutable()).toBeNull();
  });

  test('nonexistent task operations throw TaskNotFoundError', () => {
    const s = make();
    expect(() => s.updateTask('nope', {})).toThrow(TaskNotFoundError);
    expect(() => s.deleteTask('nope')).toThrow(TaskNotFoundError);
    expect(() => s.completeTask('nope')).toThrow(TaskNotFoundError);
    expect(s.getTask('nope')).toBeNull();
  });
});

describe('TaskScheduler — dynamic updates', () => {
  test('priority boost reorders claim order', () => {
    const s = make();
    s.addTask({ id: 'a', priority: 1 });
    s.addTask({ id: 'b', priority: 5 });
    s.updateTask('a', { priority: 99 });
    expect(s.claimNextExecutable()!.id).toBe('a');
  });

  test('moving executeTime into the future defers the task', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.updateTask('a', { executeTime: NOW + 10_000 });
    expect(s.claimNextExecutable()!.id).toBe('b');
    expect(s.claimNextExecutable()).toBeNull();
    expect(s.claimNextExecutable(NOW + 10_000)!.id).toBe('a');
  });

  test('moving executeTime back to now makes the task claimable', () => {
    const s = make();
    s.addTask({ id: 'a', executeTime: NOW + 10_000 });
    expect(s.claimNextExecutable()).toBeNull();
    s.updateTask('a', { executeTime: NOW });
    expect(s.claimNextExecutable()!.id).toBe('a');
  });

  test('adding an uncompleted dependency demotes READY → PENDING', () => {
    const s = make();
    s.addTask({ id: 'x' });
    s.addTask({ id: 'y' });
    s.updateTask('y', { dependencies: ['x'] });
    expect(s.getTask('y')!.status).toBe(TaskStatus.PENDING);
    expect(s.claimNextExecutable()!.id).toBe('x');
    s.completeTask('x');
    expect(s.claimNextExecutable()!.id).toBe('y');
  });

  test('adding a completed dependency keeps the task READY', () => {
    const s = make();
    s.addTask({ id: 'done' });
    s.completeTask('done');
    s.addTask({ id: 'y' });
    s.updateTask('y', { dependencies: ['done'] });
    expect(s.getTask('y')!.status).toBe(TaskStatus.READY);
    expect(s.claimNextExecutable()!.id).toBe('y');
  });

  test('dependencies: null clears the list', () => {
    const s = make();
    s.addTask({ id: 'x' });
    s.addTask({ id: 'y', dependencies: ['x'] });
    s.updateTask('y', { dependencies: null });
    expect(s.getTask('y')!.dependencies).toEqual([]);
    expect(s.getTask('y')!.status).toBe(TaskStatus.READY);
  });

  test('version increments per update; expectedVersion enforces optimistic lock', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.updateTask('a', { priority: 1 });
    expect(s.getTask('a')!.version).toBe(1);
    expect(() => s.updateTask('a', { priority: 2 }, 0)).toThrow(StaleVersionError);
    s.updateTask('a', { priority: 3 }, 1);
    expect(s.getTask('a')!.version).toBe(2);
  });

  test('updating a terminal task throws', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.completeTask('a');
    expect(() => s.updateTask('a', { priority: 5 })).toThrow(InvalidTaskError);
  });

  test('updating a RUNNING task throws', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.claimNextExecutable();
    expect(() => s.updateTask('a', { priority: 5 })).toThrow(InvalidTaskError);
  });

  test('payload update is applied', () => {
    const s = make();
    s.addTask({ id: 'a', payload: { v: 1 } });
    const next = s.updateTask('a', { payload: { v: 2 } });
    expect(next.payload).toEqual({ v: 2 });
  });

  test('updating an unknown dependency throws and leaves state untouched', () => {
    const s = make();
    s.addTask({ id: 'a' });
    expect(() => s.updateTask('a', { dependencies: ['ghost'], priority: 5 })).toThrow(
      InvalidTaskError
    );
    const a = s.getTask('a')!;
    expect(a.dependencies).toEqual([]);
    expect(a.priority).toBe(0);
    expect(a.version).toBe(0);
  });
});

describe('TaskScheduler — queries and metrics', () => {
  test('metrics reflects the full state machine', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    s.addTask({ id: 'c' });
    s.addTask({ id: 'd' });
    s.addTask({ id: 'e', executeTime: NOW + 1000 });
    s.claimNextExecutable(); // a → RUNNING
    s.failTask('c');
    s.cancelTask('d');
    const m = s.metrics();
    expect(m.total).toBe(5);
    expect(m.byStatus[TaskStatus.PENDING]).toBe(1); // b
    expect(m.byStatus[TaskStatus.RUNNING]).toBe(1); // a
    expect(m.byStatus[TaskStatus.READY]).toBe(1); // e (future)
    expect(m.byStatus[TaskStatus.FAILED]).toBe(1);
    expect(m.byStatus[TaskStatus.CANCELLED]).toBe(1);
    expect(m.dueHeapSize + m.futureHeapSize).toBe(1); // only e queued
    expect(m.totalEdges).toBe(1);
    expect(m.claimed).toBe(1);
    expect(m.failed).toBe(1);
    expect(m.cancelled).toBe(1);
  });

  test('getExecutableTasks filters on due + deps', () => {
    const s = make();
    s.addTask({ id: 'due' });
    s.addTask({ id: 'future', executeTime: NOW + 999_999 });
    s.addTask({ id: 'gated' });
    s.addTask({ id: 'gate', dependencies: ['gated'] });
    expect(s.getExecutableTasks().map((t) => t.id).sort()).toEqual(['due', 'gated']);
  });

  test('clear() resets everything', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    s.claimNextExecutable();
    s.clear();
    expect(s.metrics().total).toBe(0);
    expect(s.getAllTasks()).toHaveLength(0);
    expect(s.claimNextExecutable()).toBeNull();
    s.addTask({ id: 'a' }); // usable again after clear
  });

  test('getAllTasks returns all live tasks', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    expect(s.getAllTasks().length).toBe(2);
  });

  test('deleteTask removes from heaps and bookkeeping', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    s.addTask({ id: 'c' });
    const removed = s.deleteTask('c');
    expect(removed.id).toBe('c');
    expect(s.getTask('c')).toBeNull();
    expect(s.metrics().total).toBe(2);
    expect(s.metrics().totalEdges).toBe(1);
    expect(s.claimNextExecutable()!.id).toBe('a');
  });
});
