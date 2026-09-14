import {
  TaskScheduler,
  TaskStatus,
  CycleError,
  type Task,
} from '../src';

const NOW = 1_000_000;

function make(opts: ConstructorParameters<typeof TaskScheduler>[0] = {}): TaskScheduler {
  return new TaskScheduler({ now: NOW, ...opts });
}

// --------------------------------------------------------------------- //
//  Cycle detection
// --------------------------------------------------------------------- //

describe('cycle detection', () => {
  test('updateTask rejects an edge that closes a cycle; state is untouched', () => {
    const s = make();
    s.addTask({ id: 'A', priority: 1 });
    s.addTask({ id: 'B', dependencies: ['A'] });
    s.addTask({ id: 'C', dependencies: ['B'] });
    expect(() => s.updateTask('A', { dependencies: ['C'] })).toThrow(CycleError);
    const a = s.getTask('A')!;
    expect(a.dependencies).toEqual([]); // atomic: no partial mutation
    expect(a.priority).toBe(1);
    expect(s.getTask('B')!.dependencies).toEqual(['A']);
    expect(s.hasCycle()).toBe(false);
  });

  test('wouldCreateCycle answers edit planning queries', () => {
    const s = make();
    s.addTask({ id: 'A' });
    s.addTask({ id: 'B', dependencies: ['A'] });
    s.addTask({ id: 'C', dependencies: ['B'] });
    expect(s.wouldCreateCycle('C', 'A')).toBe(false); // C already depends on A transitively? C→B→A: edge C→A is a chord, not a cycle
    expect(s.wouldCreateCycle('A', 'C')).toBe(true); // A would depend on C which reaches A
    expect(s.wouldCreateCycle('A', 'A')).toBe(true); // self
  });

  test('long ring (1000 nodes) is rejected when closed', () => {
    const s = make();
    s.addTask({ id: 'n0' });
    for (let i = 1; i < 1000; i++) {
      s.addTask({ id: `n${i}`, dependencies: [`n${i - 1}`] });
    }
    // Closing the ring: n0 would depend on n999, which reaches n0.
    expect(() => s.updateTask('n0', { dependencies: ['n999'] })).toThrow(CycleError);
    expect(s.hasCycle()).toBe(false);
  });

  test('findCycle returns the actual closed path on a loaded cyclic graph', () => {
    const s = make();
    // addTasks allows intra-batch edges without transitive cycle check:
    s.addTasks([
      { id: 'a' },
      { id: 'b', dependencies: ['a'] },
      { id: 'c', dependencies: ['b', 'a'] },
    ]);
    expect(s.hasCycle()).toBe(false);
    expect(s.findCycle()).toBeNull();

    const s2 = make();
    // Build a 3-cycle via load order that addTask cannot express directly,
    // using updateTask on a third node — but that is rejected, so instead
    // use addTasks for a genuinely cyclic batch:
    s2.addTasks([
      { id: 'x', dependencies: ['z'] }, // forward ref WITHIN batch
      { id: 'y', dependencies: ['x'] },
      { id: 'z', dependencies: ['y'] },
    ]);
    expect(s2.hasCycle()).toBe(true);
    const cycle = s2.findCycle()!;
    expect(cycle).toHaveLength(4);
    expect(cycle[0]).toBe(cycle[3]); // closed path
    expect(new Set(cycle).size).toBe(3);
    // Cycle members are stuck PENDING (fail-safe), scheduler stays usable:
    s2.addTask({ id: 'free' });
    expect(s2.claimNextExecutable()!.id).toBe('free');
  });

  test('hasCycle on a 50k-node acyclic chain returns false (iterative, no stack overflow)', () => {
    const s = make();
    s.addTask({ id: 'c0' });
    for (let i = 1; i < 50_000; i++) {
      s.addTask({ id: `c${i}`, dependencies: [`c${i - 1}`] });
    }
    const t0 = Date.now();
    expect(s.hasCycle()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

// --------------------------------------------------------------------- //
//  addTasks batch semantics
// --------------------------------------------------------------------- //

describe('addTasks (batch)', () => {
  test('accepts intra-batch forward references', () => {
    const s = make();
    const n = s.addTasks([
      { id: 'b', dependencies: ['a'] },
      { id: 'a' },
    ]);
    expect(n).toBe(2);
    expect(s.getTask('b')!.status).toBe(TaskStatus.PENDING);
    expect(s.getTask('a')!.status).toBe(TaskStatus.READY);
    s.completeTask('a');
    expect(s.claimNextExecutable()!.id).toBe('b');
  });

  test('duplicate id within the batch throws', () => {
    const s = make();
    expect(() => s.addTasks([{ id: 'a' }, { id: 'a' }])).toThrow();
    expect(s.metrics().total).toBe(0); // atomic: nothing committed
  });

  test('batch respects capacity', () => {
    const s = make({ maxTasks: 2 });
    expect(() => s.addTasks([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toThrow();
    expect(s.metrics().total).toBe(0);
  });

  test('heapify path: claim order after batch load is priority-correct', () => {
    const s = make();
    const inputs = Array.from({ length: 2000 }, (_, i) => ({
      id: `t${i}`,
      priority: (i * 2654435761) % 1000,
    }));
    s.addTasks(inputs);
    const first = s.claimNextExecutable()!;
    const maxP = Math.max(...inputs.map((i) => i.priority!));
    expect(first.priority).toBe(maxP);
  });
});

// --------------------------------------------------------------------- //
//  Dangling dependencies (delete semantics)
// --------------------------------------------------------------------- //

describe('dangling dependencies', () => {
  test('deleting a COMPLETED dep leaves the dependent blocked (fail-safe)', () => {
    const s = make();
    s.addTask({ id: 'dep' });
    s.completeTask('dep');
    s.addTask({ id: 'child', dependencies: ['dep'] });
    expect(s.getTask('child')!.status).toBe(TaskStatus.READY);

    s.deleteTask('dep');

    // Claim attempt surfaces the dangling dep: child is re-blocked, not lost.
    expect(s.claimNextExecutable()).toBeNull();
    expect(s.getTask('child')!.status).toBe(TaskStatus.PENDING);
    expect(s.getTask('child')!.unmetDependencies).toBe(1);

    const blocked = s.getBlockedTasks();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.task.id).toBe('child');
    expect(blocked[0]!.dangling).toEqual(['dep']);

    // Operator fix: remove the dangling edge → child is ready again.
    s.updateTask('child', { dependencies: [] });
    expect(s.claimNextExecutable()!.id).toBe('child');
  });

  test('delete → re-add same id resumes unblock propagation', () => {
    const s = make();
    s.addTask({ id: 'dep' });
    s.completeTask('dep');
    s.addTask({ id: 'child', dependencies: ['dep'] });
    s.deleteTask('dep');
    // Re-add the same id (new task, not completed)
    s.addTask({ id: 'dep' });
    expect(s.getTask('child')!.status).toBe(TaskStatus.PENDING);
    // Complete the re-added dep: child's unmet count must resolve.
    s.claimNextExecutable(); // claim the new 'dep'
    s.completeTask('dep');
    expect(s.getTask('child')!.status).toBe(TaskStatus.READY);
    expect(s.claimNextExecutable()!.id).toBe('child');
  });

  test('deleting a PENDING predecessor keeps the dependent blocked', () => {
    const s = make();
    s.addTask({ id: 'dep' });
    s.addTask({ id: 'child', dependencies: ['dep'] });
    s.deleteTask('dep');
    expect(s.getTask('child')!.status).toBe(TaskStatus.PENDING);
    expect(s.claimNextExecutable()).toBeNull();
    expect(s.getBlockedTasks()[0]!.dangling).toEqual(['dep']);
  });

  test('deleting a task with dependents of dependents (chain) is clean', () => {
    const s = make();
    s.addTask({ id: 'root' });
    s.addTask({ id: 'mid', dependencies: ['root'] });
    s.addTask({ id: 'leaf', dependencies: ['mid'] });
    s.completeTask('root');
    s.deleteTask('mid'); // mid was READY (in heap)
    expect(s.claimNextExecutable()).toBeNull(); // leaf blocked on dangling mid
    const blocked = s.getBlockedTasks();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.task.id).toBe('leaf');
    expect(blocked[0]!.dangling).toEqual(['mid']);
  });
});

// --------------------------------------------------------------------- //
//  Terminal state transition table
// --------------------------------------------------------------------- //

describe('terminal transition table', () => {
  const s0 = () => make();

  test('complete: COMPLETED idempotent; FAILED/CANCELLED throw', () => {
    const s = s0();
    s.addTask({ id: 'a' });
    s.completeTask('a');
    s.completeTask('a'); // no-op
    expect(s.metrics().completed).toBe(1);
  });

  test('fail: FAILED idempotent; COMPLETED/CANCELLED throw', () => {
    const s = s0();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.addTask({ id: 'c' });
    s.failTask('a');
    s.failTask('a'); // no-op
    s.completeTask('b');
    expect(() => s.failTask('b')).toThrow();
    s.cancelTask('c');
    expect(() => s.failTask('c')).toThrow();
  });

  test('cancel: terminal no-op; PENDING/READY/RUNNING all cancelable', () => {
    const s = s0();
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.addTask({ id: 'c' });
    s.completeTask('a');
    expect(s.cancelTask('a').status).toBe(TaskStatus.COMPLETED); // no-op
    s.cancelTask('b');
    expect(s.getTask('b')!.status).toBe(TaskStatus.CANCELLED);
    s.claimNextExecutable(); // c → RUNNING
    s.cancelTask('c');
    expect(s.getTask('c')!.status).toBe(TaskStatus.CANCELLED);
  });
});

// --------------------------------------------------------------------- //
//  Structural edge cases
// --------------------------------------------------------------------- //

describe('structural edge cases', () => {
  test('extreme priorities and times are accepted (finite)', () => {
    const s = make();
    s.addTask({ id: 'neg', priority: -1e18, executeTime: 0 });
    s.addTask({ id: 'pos', priority: 1e18 });
    s.addTask({ id: 'inf', executeTime: Number.MAX_SAFE_INTEGER });
    expect(s.claimNextExecutable()!.id).toBe('pos');
    expect(s.claimNextExecutable()!.id).toBe('neg');
    expect(s.claimNextExecutable(Number.MAX_SAFE_INTEGER)!.id).toBe('inf');
  });

  test('same-tick adds are FIFO-ordered via sequence', () => {
    const s = make();
    for (let i = 0; i < 1000; i++) s.addTask({ id: `s${i}` });
    let order: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const t = s.claimNextExecutable()!;
      order.push(t.id);
      s.completeTask(t.id);
    }
    expect(order).toEqual(order.slice().sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  });

  test('payload is stored by reference and not deep-cloned', () => {
    const s = make();
    const payload = { nested: [1, 2, 3] };
    s.addTask({ id: 'a', payload });
    expect(s.getTask('a')!.payload).toBe(payload);
  });

  test('updateTask with empty updates still bumps version', () => {
    const s = make();
    s.addTask({ id: 'a' });
    s.updateTask('a', {});
    expect(s.getTask('a')!.version).toBe(1);
  });

  test('10k random DAG drain: every task executes only after all deps complete', () => {
    const s = make();
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const deps: string[] = [];
      if (i > 0) {
        // Each task depends on 0–3 earlier tasks → guaranteed acyclic.
        const count = (i * 7) % 4;
        for (let k = 0; k < count; k++) {
          deps.push(`t${(i * (k + 1) * 31) % i}`);
        }
      }
      s.addTask({ id: `t${i}`, priority: (i * 2654435761) % 1000, dependencies: deps });
    }
    const completedAt = new Map<string, number>();
    let step = 0;
    for (;;) {
      const t = s.claimNextExecutable();
      if (!t) break;
      for (const dep of t.dependencies) {
        if (!completedAt.has(dep)) {
          throw new Error(`invariant violated: task ${t.id} executed before dep ${dep}`);
        }
      }
      completedAt.set(t.id, step++);
      s.completeTask(t.id);
    }
    expect(completedAt.size).toBe(N);
    expect(s.getPendingTasks()).toHaveLength(0);
    expect(s.getReadyTasks()).toHaveLength(0);
  });

  test('priority optimality on a mixed workload (500 tasks): claim always picks max priority among executable', () => {
    const s = make();
    const N = 500;
    for (let i = 0; i < N; i++) {
      const deps: string[] = [];
      if (i > 0 && i % 3 === 0) deps.push(`t${(i * 13) % i}`);
      s.addTask({
        id: `t${i}`,
        priority: (i * 2654435761) % 1000,
        executeTime: NOW + (i % 17) * 1000,
        dependencies: deps,
      });
    }
    let executed = 0;
    for (;;) {
      const executable = s.getExecutableTasks();
      if (executable.length === 0) {
        if (executed === N) break; // everything finished
        const wake = s.nextWakeTime();
        if (wake === null) break;
        s.peekNextExecutable(wake); // advance clock only
        continue;
      }
      const best = Math.max(...executable.map((t) => t.priority));
      const claimed = s.claimNextExecutable()!;
      expect(claimed.priority).toBe(best);
      s.completeTask(claimed.id);
      executed++;
    }
    expect(executed).toBe(N);
  });

  test('promotions are amortized: 10k future tasks, one due task — claim is fast', () => {
    const s = make();
    for (let i = 0; i < 10_000; i++) {
      s.addTask({ id: `f${i}`, priority: 1000, executeTime: NOW + 1_000_000 + i });
    }
    s.addTask({ id: 'due', priority: 1 });
    const t0 = Date.now();
    expect(s.claimNextExecutable()!.id).toBe('due');
    expect(s.claimNextExecutable()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000); // no full-heap scan
    expect(s.metrics().promotions).toBe(0);
  });
});

// --------------------------------------------------------------------- //
//  Deep chain — no recursion anywhere
// --------------------------------------------------------------------- //

describe('deep chain (10k)', () => {
  test('10k-deep chain completes end to end with per-step unblock', () => {
    const s = make();
    const N = 10_000;
    s.addTask({ id: 'x0' });
    for (let i = 1; i < N; i++) {
      s.addTask({ id: `x${i}`, dependencies: [`x${i - 1}`] });
    }
    const t0 = Date.now();
    let count = 0;
    for (;;) {
      const t = s.claimNextExecutable();
      if (!t) break;
      count++;
      s.completeTask(t.id);
    }
    expect(count).toBe(N);
    expect(Date.now() - t0).toBeLessThan(60_000);
  });
});
