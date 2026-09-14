import { TaskScheduler, TaskStatus } from '../src';

describe('BinaryHeap', () => {
  let s: TaskScheduler;
  beforeEach(() => {
    s = new TaskScheduler({ now: 1_000_000 });
  });

  test('addTask creates READY task when no deps', () => {
    const a = s.addTask({ id: 'a', payload: 'a', priority: 5, dependencies: [] });
    expect(a.status).toBe(TaskStatus.READY);
  });

  test('addTask creates PENDING task when deps unmet', () => {
    s.addTask({ id: 'b', payload: 'b', priority: 3, dependencies: [] });
    const c = s.addTask({ id: 'c', payload: 'c', priority: 3, dependencies: ['b'] });
    expect(c.status).toBe(TaskStatus.PENDING);
  });

  test('updateTask priority change is reflected in next task', () => {
    s.addTask({ id: 'x', payload: 1, priority: 1 });
    s.addTask({ id: 'y', payload: 2, priority: 1 });
    s.updateTask('y', { priority: 10 });
    const next = s.executeNextTask();
    expect(next?.id).toBe('y');
  });

  test('deleteTask removes task; dependents stay blocked', () => {
    s.addTask({ id: 'p', payload: 1, priority: 5 });
    s.addTask({ id: 'q', payload: 2, priority: 5, dependencies: ['p'] });
    s.deleteTask('p');
    expect(s.getTask('p')).toBeNull();
    expect(s.executeNextTask()).toBeNull();
  });
});

describe('TaskScheduler basics', () => {
  let s: TaskScheduler;
  beforeEach(() => {
    s = new TaskScheduler({ now: 1_000_000 });
  });

  test('addTask creates task', () => {
    const t = s.addTask({ id: 't1', payload: 'hello', priority: 5, dependencies: [] });
    expect(t.status).toBe(TaskStatus.READY);
    expect(t.payload).toBe('hello');
    expect(t.priority).toBe(5);
  });

  test('executeNextTask runs highest priority first', () => {
    s.addTask({ id: 'low', payload: 1, priority: 1 });
    s.addTask({ id: 'high', payload: 2, priority: 10 });
    s.addTask({ id: 'mid', payload: 3, priority: 5 });
    const n1 = s.executeNextTask();
    const n2 = s.executeNextTask();
    const n3 = s.executeNextTask();
    expect(n1?.id).toBe('high');
    expect(n2?.id).toBe('mid');
    expect(n3?.id).toBe('low');
  });

  test('dependency resolution: PENDING -> READY', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    const b = s.addTask({ id: 'b', payload: 2, priority: 5, dependencies: ['a'] });
    expect(b.status).toBe(TaskStatus.PENDING);
    s.completeTask('a');
    expect(s.getTask('b')?.status).toBe(TaskStatus.READY);
    const next = s.executeNextTask();
    expect(next?.id).toBe('b');
  });

  test('dependency resolution: cancelled/failed dep blocks', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    s.addTask({ id: 'b', payload: 2, priority: 5, dependencies: ['a'] });
    s.cancelTask('a');
    const next = s.executeNextTask();
    expect(next).toBeNull();
  });

  test('wouldCreateCycle detects cycle', () => {
    s.addTask({ id: 'a', payload: 1, dependencies: [] });
    s.addTask({ id: 'b', payload: 2, dependencies: ['a'] });
    s.addTask({ id: 'c', payload: 3, dependencies: ['b'] });
    expect(s.wouldCreateCycle('a', 'c')).toBe(true);
    expect(s.wouldCreateCycle('a', 'b')).toBe(true);
    expect(s.wouldCreateCycle('c', 'a')).toBe(false);
  });

  test('hasCycle detects real cycle', () => {
    s.addTask({ id: 'a', payload: 1, dependencies: [] });
    s.addTask({ id: 'b', payload: 2, dependencies: ['a'] });
    s.addTask({ id: 'c', payload: 3, dependencies: ['b'] });
    s.updateTask('a', { dependencies: ['c'] });
    expect(s.hasCycle()).toBe(true);
  });

  test('hasCycle false for DAG', () => {
    s.addTask({ id: 'a', payload: 1, dependencies: [] });
    s.addTask({ id: 'b', payload: 2, dependencies: ['a'] });
    s.addTask({ id: 'c', payload: 3, dependencies: ['b'] });
    expect(s.hasCycle()).toBe(false);
  });

  test('updateTask priority change reflected', () => {
    s.addTask({ id: 'x', payload: 1, priority: 1 });
    s.addTask({ id: 'y', payload: 2, priority: 1 });
    s.updateTask('y', { priority: 10 });
    expect(s.executeNextTask()?.id).toBe('y');
  });

  test('updateTask dependency change unblocks', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    const b = s.addTask({ id: 'b', payload: 2, priority: 5, dependencies: ['a'] });
    expect(b.status).toBe(TaskStatus.PENDING);
    s.updateTask('b', { dependencies: [] });
    expect(s.getTask('b')?.status).toBe(TaskStatus.READY);
  });

  test('updateTask priority change after READY', () => {
    s.addTask({ id: 'x', payload: 1, priority: 1 });
    s.addTask({ id: 'y', payload: 2, priority: 1 });
    s.updateTask('y', { priority: 10 });
    expect(s.executeNextTask()?.id).toBe('y');
    expect(s.executeNextTask()?.id).toBe('x');
  });

  test('executeNextTask with future executeTime delays', () => {
    s.addTask({ id: 'f', payload: 1, priority: 5, executeTime: 2_000_000 });
    const n = s.executeNextTask();
    expect(n).toBeNull();
    s.setNow(2_000_001);
    const n2 = s.executeNextTask();
    expect(n2?.id).toBe('f');
  });

  test('metrics are accurate', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    s.addTask({ id: 'b', payload: 2, priority: 5, dependencies: ['a'] });
    s.executeNextTask();
    s.completeTask('a');
    const m = s.metrics();
    expect(m.total).toBe(2);
    expect(m.completed).toBe(1);
    expect(m.executable).toBe(1);
  });

  test('clear resets everything', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    s.clear();
    expect(s.metrics().total).toBe(0);
    expect(s.executeNextTask()).toBeNull();
  });

  test('failTask leaves dependents blocked', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    const b = s.addTask({ id: 'b', payload: 2, priority: 5, dependencies: ['a'] });
    s.failTask('a');
    expect(b.status).toBe(TaskStatus.PENDING);
    expect(s.executeNextTask()).toBeNull();
  });

  test('updateTask changes dependency correctly', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    s.addTask({ id: 'b', payload: 2, priority: 5, dependencies: [] });
    const c = s.addTask({ id: 'c', payload: 3, priority: 5, dependencies: ['a'] });
    expect(c.status).toBe(TaskStatus.PENDING);
    s.updateTask('c', { dependencies: ['b'] });
    expect(c.status).toBe(TaskStatus.PENDING);
    s.completeTask('b');
    expect(c.status).toBe(TaskStatus.READY);
  });

  test('duplicate addTask throws', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    expect(() => s.addTask({ id: 'a', payload: 2, priority: 5, dependencies: [] })).toThrow();
  });

  test('invalid dependency id throws', () => {
    expect(() => s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [''] })).toThrow();
  });
});

describe('1M tasks scalability', () => {
  test('can add 10k tasks and execute in priority order', () => {
    const s = new TaskScheduler({ now: 0 });
    const N = 10_000;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      let deps: string[] = [];
      if (Math.random() < 0.1 && i > 0) {
        deps = [ids[Math.floor(Math.random() * i)]];
      }
      ids.push(s.addTask({
        id: `t${i}`,
        payload: i,
        priority: Math.floor(Math.random() * 100),
        dependencies: deps,
      }).id);
    }
    const m = s.metrics();
    expect(m.total).toBe(N);
    expect(m.executable).toBeGreaterThan(0);
    let ran = 0;
    while (s.executeNextTask()) ran++;
    expect(ran).toBe(N);
  });

  test('addTask capacity limit', () => {
    const s = new TaskScheduler({ maxTasks: 5, now: 0 });
    for (let i = 0; i < 5; i++) s.addTask({ id: `t${i}`, payload: i, priority: 0 });
    expect(() => s.addTask({ id: 'overflow', payload: 99, priority: 0 })).toThrow();
  });

  test('can add 1M tasks', () => {
    const s = new TaskScheduler({ now: 0 });
    const N = 1_000_000;
    for (let i = 0; i < N; i++) {
      s.addTask({
        id: `t${i}`,
        payload: i,
        priority: 0,
        dependencies: [],
      });
    }
    const m = s.metrics();
    expect(m.total).toBe(N);
    expect(m.heapSize).toBe(N);
  });
});

describe('Edge cases', () => {
  let s: TaskScheduler;
  beforeEach(() => {
    s = new TaskScheduler({ now: 0 });
  });

  test('self-dependency prevented', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    s.updateTask('a', { dependencies: ['a'] });
    expect(s.hasCycle()).toBe(true);
  });

  test('re-completing a completed task is a no-op', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    s.executeNextTask();
    s.completeTask('a');
    expect(s.metrics().completed).toBe(1);
  });

  test('completing a cancelled task throws', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    s.cancelTask('a');
    expect(() => s.completeTask('a')).toThrow();
  });

  test('cancelTask removes from heap', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, dependencies: [] });
    s.cancelTask('a');
    expect(s.metrics().heapSize).toBe(0);
    expect(s.executeNextTask()).toBeNull();
  });

  test('priority tie-break by executeTime then createdAt', () => {
    s.addTask({ id: 'a', payload: 1, priority: 5, executeTime: 2 });
    s.addTask({ id: 'b', payload: 2, priority: 5, executeTime: 1 });
    // Set a slower clock for 'c' so it gets a later createdAt.
    s.setNow(10);
    s.addTask({ id: 'c', payload: 3, priority: 5, executeTime: 1 });
    const n1 = s.executeNextTask();
    const n2 = s.executeNextTask();
    const n3 = s.executeNextTask();
    expect(n1?.id).toBe('b');
    expect(n2?.id).toBe('c');
    expect(n3?.id).toBe('a');
  });

  test('dynamic update during execution changes next task', () => {
    s.addTask({ id: 'a', payload: 1, priority: 1 });
    s.addTask({ id: 'b', payload: 2, priority: 1 });
    s.executeNextTask();
    s.updateTask('b', { priority: 100 });
    s.executeNextTask();
    expect(s.getTask('b')?.status).toBe(TaskStatus.COMPLETED);
  });
});
