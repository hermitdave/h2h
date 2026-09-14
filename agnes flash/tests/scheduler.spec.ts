import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { BinaryHeap } from '../src/binary-heap';
import { TaskScheduler } from '../src/scheduler';
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
} from '../src/errors';
import type { NextTaskResult, SchedulerOptions, Task } from '../src/types';
import { FakeClock } from './helpers/fake-clock';

/** A scheduler wired to a deterministic fake clock. */
function makeScheduler(opts: Partial<SchedulerOptions> = {}) {
  const clock = new FakeClock();
  return {
    clock,
    scheduler: new TaskScheduler({ nowProvider: () => clock.now(), ...opts }),
  };
}

/** Sequential execution ids for the next `count` executable tasks. */
async function executionOrder(scheduler: TaskScheduler, count: number, now?: number): Promise<string[]> {
  const order: string[] = [];
  for (let i = 0; i < count; i++) {
    const res = await scheduler.executeNextTask(now);
    if (res.kind === 'none') break;
    order.push(res.task.id);
  }
  return order;
}

/** Narrow to the executed variant, with a runtime kind guard. */
function asExecuted(res: NextTaskResult): Extract<NextTaskResult, { kind: 'executed' }> {
  if (res.kind !== 'executed') throw new Error(`expected kind=executed, got ${res.kind}`);
  return res;
}

/** Narrow to the running variant, with a runtime kind guard. */
function asRunning(res: NextTaskResult): Extract<NextTaskResult, { kind: 'running' }> {
  if (res.kind !== 'running') throw new Error(`expected kind=running, got ${res.kind}`);
  return res;
}

describe('BinaryHeap', () => {
  it('pop yields entries in comparator order', () => {
    const heap = new BinaryHeap<number>((a: number, b: number) => b - a);
    for (const v of [3, 10, 1, 7]) heap.push(v);
    const sequence: number[] = [];
    let top: number | undefined;
    while ((top = heap.pop()) !== undefined) sequence.push(top);
    expect(sequence).toEqual([10, 7, 3, 1]);
  });

  it('remove relocates the tail and preserves heap order', () => {
    const heap = new BinaryHeap<number>((a: number, b: number) => b - a);
    for (const v of [5, 9, 2, 8, 1]) heap.push(v);
    expect(heap.remove(9)).toBe(true); // root
    expect(heap.remove(2)).toBe(true); // leaf
    expect(heap.contains(9)).toBe(false);
    const sequence: number[] = [];
    let top: number | undefined;
    while ((top = heap.pop()) !== undefined) sequence.push(top);
    expect(sequence).toEqual([8, 5, 1]);
  });

  it('remove of a missing key returns false and leaves the heap intact', () => {
    const heap = new BinaryHeap<number>((a: number, b: number) => b - a);
    heap.push(5);
    expect(heap.remove(42)).toBe(false);
    expect(heap.size).toBe(1);
    expect(heap.peek()).toBe(5);
  });

  it('supports external-state comparators with in-place key updates', () => {
    const weights = new Map<string, number>();
    const heap = new BinaryHeap<string>((a: string, b: string) => {
      const wa = weights.get(a) ?? 0;
      const wb = weights.get(b) ?? 0;
      return wa === wb ? 0 : wa > wb ? -1 : 1;
    });
    weights.set('low', 1);
    weights.set('high', 9);
    heap.push('low');
    heap.push('high');
    expect(heap.peek()).toBe('high');
    weights.set('low', 10);
    heap.push('low'); // in-place update: re-sift from its current slot
    expect(heap.peek()).toBe('low');
    heap.remove('low');
    expect(heap.peek()).toBe('high');
  });

  it('heapify builds a heap in bulk', () => {
    const heap = new BinaryHeap<number>((a: number, b: number) => b - a);
    heap.heapify([3, 9, 1, 8, 5]);
    const sequence: number[] = [];
    let top: number | undefined;
    while ((top = heap.pop()) !== undefined) sequence.push(top);
    expect(sequence).toEqual([9, 8, 5, 3, 1]);
  });

  it('peek and size track the heap state', () => {
    const heap = new BinaryHeap<number>((a: number, b: number) => b - a);
    expect(heap.peek()).toBeUndefined();
    expect(heap.size).toBe(0);
    heap.push(4);
    heap.push(9);
    expect(heap.peek()).toBe(9);
    expect(heap.size).toBe(2);
  });
});

describe('TaskScheduler — registration', () => {
  it('addTask applies documented defaults', async () => {
    const { scheduler, clock } = makeScheduler();
    const task = await scheduler.addTask({ id: 'a' });
    expect(task.id).toBe('a');
    expect(task.status).toBe('READY'); // no dependencies
    expect(task.priority).toBe(0);
    expect(task.executeTime).toBe(clock.value);
    expect(task.createdAt).toBe(clock.value);
    expect(task.attempts).toBe(0);
  });

  it('addTask rejects duplicate ids', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'a' });
    await expect(scheduler.addTask({ id: 'a' })).rejects.toBeInstanceOf(DuplicateTaskError);
    expect(scheduler.getTask('a')).toBeDefined(); // original untouched
  });

  it('addTask rejects malformed input', async () => {
    const { scheduler } = makeScheduler();
    await expect(scheduler.addTask({ id: '' })).rejects.toBeInstanceOf(InvalidTaskError);
    await expect(
      scheduler.addTask({ id: 'a', priority: Number.NaN }),
    ).rejects.toBeInstanceOf(InvalidTaskError);
    await expect(
      scheduler.addTask({ id: 'b', executeTime: Number.POSITIVE_INFINITY }),
    ).rejects.toBeInstanceOf(InvalidTaskError);
    expect(scheduler.getTask('a')).toBeUndefined(); // nothing registered
  });

  it('mutation ops reject unknown ids', async () => {
    const { scheduler } = makeScheduler();
    await expect(scheduler.completeTask('ghost')).rejects.toBeInstanceOf(UnknownTaskError);
    await expect(scheduler.failTask('ghost')).rejects.toBeInstanceOf(UnknownTaskError);
    await expect(scheduler.cancelTask('ghost')).rejects.toBeInstanceOf(UnknownTaskError);
    await expect(scheduler.resetTask('ghost')).rejects.toBeInstanceOf(UnknownTaskError);
    await expect(scheduler.updateTask('ghost', { priority: 1 })).rejects.toBeInstanceOf(
      UnknownTaskError,
    );
    await expect(scheduler.deleteTask('ghost')).rejects.toBeInstanceOf(UnknownTaskError);
  });

  it('addTask rejects unknown dependencies in strict mode', async () => {
    const { scheduler } = makeScheduler();
    await expect(
      scheduler.addTask({ id: 'x', dependencies: ['missing'] }),
    ).rejects.toBeInstanceOf(InvalidDependencyError);
    expect(scheduler.getTask('x')).toBeUndefined(); // nothing registered
  });

  it('forward references are accepted when allowForwardRefs is set', async () => {
    const { scheduler } = makeScheduler({ allowForwardRefs: true });
    const x = await scheduler.addTask({ id: 'x', dependencies: ['phantom'] });
    expect(x.status).toBe('PENDING'); // blocked on the missing dep
    expect(x.dependencies.has('phantom')).toBe(true); // registered as forward ref
  });

  it('forward references reconcile once the referenced task completes', async () => {
    const { scheduler, clock } = makeScheduler({ allowForwardRefs: true });
    await scheduler.addTask({ id: 'x', dependencies: ['phantom'] });
    expect(scheduler.getTask('x')!.status).toBe('PENDING');
    await scheduler.addTask({ id: 'phantom' });
    expect(scheduler.getTask('x')!.status).toBe('PENDING'); // still blocked: not completed yet
    await scheduler.completeTask('phantom', clock.value);
    expect(scheduler.getTask('phantom')!.status).toBe('COMPLETED');
    expect(scheduler.getTask('x')!.status).toBe('READY'); // unblocked on completion
  });

  it('addTask fails immediately when a dependency already failed', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'bad' });
    await scheduler.failTask('bad', 'exploded');
    const x = await scheduler.addTask({ id: 'x', dependencies: ['bad'] });
    expect(x.status).toBe('FAILED');
    expect(x.failureReason).toBe('upstream_failed:bad');
  });

  it('addTask rejects self-dependencies with cycle evidence', async () => {
    const { scheduler } = makeScheduler();
    await expect(
      scheduler.addTask({ id: 'a', dependencies: ['a'] }),
    ).rejects.toBeInstanceOf(CycleError);
    expect(scheduler.getTask('a')).toBeUndefined(); // nothing registered
  });
});

describe('TaskScheduler — ordering', () => {
  it('executes tasks in descending priority order', async () => {
    const { scheduler, clock } = makeScheduler();
    const t = clock.value;
    await scheduler.addTask({ id: 'p1', priority: 1, executeTime: t });
    await scheduler.addTask({ id: 'p3', priority: 3, executeTime: t });
    await scheduler.addTask({ id: 'p5', priority: 5, executeTime: t });
    const order = await executionOrder(scheduler, 3, t);
    expect(order).toEqual(['p5', 'p3', 'p1']);
  });

  it('priority ties broken by earlier executeTime', async () => {
    const { scheduler, clock } = makeScheduler();
    await scheduler.addTask({ id: 'late', priority: 5, executeTime: clock.value + 5_000 });
    await scheduler.addTask({ id: 'early', priority: 5, executeTime: clock.value });
    const order = await executionOrder(scheduler, 2, clock.value);
    expect(order).toEqual(['early']); // late is future-dated: deferred
    expect(scheduler.getTask('late')!.status).toBe('READY'); // preserved for later
  });

  it('remaining ties broken by earlier createdAt', async () => {
    const { scheduler, clock } = makeScheduler();
    const t = clock.value;
    await scheduler.addTask({ id: 'zeta', priority: 5, executeTime: t });
    clock.advance(1_000);
    await scheduler.addTask({ id: 'alpha', priority: 5, executeTime: t });
    const order = await executionOrder(scheduler, 2, t);
    expect(order).toEqual(['zeta', 'alpha']); // zeta has the earlier createdAt
  });

  it('full ties broken by id', async () => {
    const { scheduler, clock } = makeScheduler();
    const t = clock.value;
    await scheduler.addTask({ id: 'zeta', priority: 5, executeTime: t });
    await scheduler.addTask({ id: 'alpha', priority: 5, executeTime: t });
    const order = await executionOrder(scheduler, 2, t);
    expect(order).toEqual(['alpha', 'zeta']); // lexicographic id tie-break
  });
});

describe('TaskScheduler — dependencies', () => {
  it('dep completion unblocks dependents', async () => {
    const onTaskUnblocked = vi.fn(async () => {});
    const { scheduler, clock } = makeScheduler({ hooks: { onTaskUnblocked } });
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    expect(scheduler.getTask('B')!.status).toBe('PENDING');
    await scheduler.completeTask('A', clock.value);
    expect(scheduler.getTask('B')!.status).toBe('READY');
    expect(onTaskUnblocked).toHaveBeenCalledTimes(1);
    expect(onTaskUnblocked).toHaveBeenCalledWith(expect.objectContaining({ id: 'B' }));
    expect(scheduler.getMetrics().unblocked).toBe(1);
  });

  it('unblocking propagates transitively down chains', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.addTask({ id: 'C', dependencies: ['B'] });
    expect(scheduler.getTask('C')!.status).toBe('PENDING');
    const first = await scheduler.executeNextTask();
    expect(asRunning(first).task.id).toBe('A');
    await scheduler.completeTask('A');
    expect(scheduler.getTask('B')!.status).toBe('READY');
    const second = await scheduler.executeNextTask();
    expect(asRunning(second).task.id).toBe('B');
    await scheduler.completeTask('B');
    expect(scheduler.getTask('C')!.status).toBe('READY');
  });

  it('future executeTime defers execution until the clock reaches it', async () => {
    const { scheduler, clock } = makeScheduler();
    await scheduler.addTask({ id: 'soon' });
    await scheduler.addTask({ id: 'later', executeTime: clock.value + 60_000 });
    let res = await scheduler.executeNextTask(clock.value);
    expect(asRunning(res).task.id).toBe('soon'); // higher urgency executes first
    await scheduler.completeTask('soon', clock.value);
    res = await scheduler.executeNextTask(clock.value);
    expect(res.kind).toBe('none'); // only the future-dated task remains
    expect(scheduler.getTask('later')!.status).toBe('READY'); // deferred task preserved
    expect(scheduler.getMetrics().heapSize).toBe(1);
    clock.advance(60_000);
    res = await scheduler.executeNextTask(clock.value);
    expect(asRunning(res).task.id).toBe('later');
    await scheduler.completeTask('later', clock.value);
    expect(scheduler.getTask('later')!.status).toBe('COMPLETED');
  });
});

describe('TaskScheduler — failure propagation', () => {
  it('failed dep fails direct dependents', async () => {
    const onTaskFailed = vi.fn(async () => {});
    const { scheduler } = makeScheduler({ hooks: { onTaskFailed } });
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.failTask('A', 'boom');
    expect(scheduler.getTask('A')!.status).toBe('FAILED');
    expect(scheduler.getTask('A')!.failureReason).toBe('boom');
    expect(scheduler.getTask('B')!.status).toBe('FAILED');
    expect(scheduler.getTask('B')!.failureReason).toBe('boom');
    expect(onTaskFailed).toHaveBeenCalledTimes(2); // origin + victim
    expect(scheduler.getMetrics().propagatedFailures).toBeGreaterThanOrEqual(1);
  });

  it('failure propagates transitively through dependent chains', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.addTask({ id: 'C', dependencies: ['B'] });
    await scheduler.failTask('A', 'boom');
    expect(scheduler.getTask('A')!.status).toBe('FAILED');
    expect(scheduler.getTask('B')!.status).toBe('FAILED');
    expect(scheduler.getTask('B')!.failureReason).toBe('boom');
    expect(scheduler.getTask('C')!.status).toBe('FAILED');
    expect(scheduler.getTask('C')!.failureReason).toBe('boom');
  });

  it('cancelled dep fails dependents', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.cancelTask('A', 'obsolete');
    expect(scheduler.getTask('A')!.status).toBe('CANCELLED');
    expect(scheduler.getTask('B')!.status).toBe('FAILED');
    expect(scheduler.getTask('B')!.failureReason).toBe('obsolete');
  });

  it('completed upstreams are never retroactively failed', async () => {
    const { scheduler } = makeScheduler({ runner: async (task: Task) => {} });
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.addTask({ id: 'C', dependencies: ['B'] });
    const first = await scheduler.executeNextTask();
    expect(asExecuted(first).task.id).toBe('A');
    const second = await scheduler.executeNextTask();
    expect(asExecuted(second).task.id).toBe('B'); // unblocked by A's completion
    expect(scheduler.getTask('C')!.status).toBe('READY'); // unblocked by B's
    await scheduler.resetTask('A');
    await scheduler.failTask('A', 'retry-error');
    expect(scheduler.getTask('A')!.status).toBe('FAILED');
    expect(scheduler.getTask('B')!.status).toBe('COMPLETED'); // success is success
    expect(scheduler.getTask('C')!.status).toBe('READY'); // dep B succeeded: not a victim
  });
});

describe('TaskScheduler — dynamic updates', () => {
  it('priority update re-seats the heap', async () => {
    const { scheduler, clock } = makeScheduler();
    const t = clock.value;
    await scheduler.addTask({ id: 'low', priority: 1, executeTime: t });
    await scheduler.addTask({ id: 'high', priority: 9, executeTime: t });
    await scheduler.updateTask('high', { priority: 0 });
    const res = await scheduler.executeNextTask(t);
    expect(res.kind).toBe('running');
    expect(asRunning(res).task.id).toBe('low'); // demotion re-ordered the heap
  });

  it('adding an unmet dependency demotes a READY task to PENDING', async () => {
    const { scheduler, clock } = makeScheduler();
    const t = clock.value;
    await scheduler.addTask({ id: 'dep', executeTime: t + 1_000 });
    await scheduler.addTask({ id: 'x', executeTime: t });
    expect(scheduler.getTask('x')!.status).toBe('READY');
    await scheduler.updateTask('x', { dependencies: ['dep'] });
    expect(scheduler.getTask('x')!.status).toBe('PENDING');
    expect(scheduler.getMetrics().heapSize).toBe(1); // only 'dep' remains
  });

  it('removing a dependency never demotes; satisfied deps promote', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'dep' });
    await scheduler.addTask({ id: 'x', dependencies: ['dep'] });
    expect(scheduler.getTask('x')!.status).toBe('PENDING');
    await scheduler.completeTask('dep');
    expect(scheduler.getTask('x')!.status).toBe('READY'); // unblocked
    await scheduler.updateTask('x', { dependencies: [] });
    expect(scheduler.getTask('x')!.status).toBe('READY'); // still satisfied
  });

  it('adding a failed dependency fails the task and propagates downstream', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'bad' });
    await scheduler.addTask({ id: 'good' });
    await scheduler.addTask({ id: 'x', dependencies: ['good'] });
    await scheduler.addTask({ id: 'y', dependencies: ['x'] });
    await scheduler.completeTask('good');
    expect(scheduler.getTask('x')!.status).toBe('READY');
    await scheduler.failTask('bad', 'exploded');
    await scheduler.updateTask('x', { dependencies: ['good', 'bad'] });
    expect(scheduler.getTask('x')!.status).toBe('FAILED');
    expect(scheduler.getTask('x')!.failureReason).toBe('upstream_failed:bad');
    expect(scheduler.getTask('y')!.status).toBe('FAILED');
    expect(scheduler.getTask('y')!.failureReason).toBe('upstream_failed:bad');
    expect(scheduler.getTask('good')!.status).toBe('COMPLETED'); // untouched
  });

  it('update on a terminal task is rejected', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'done', priority: 1 });
    await scheduler.completeTask('done');
    await expect(scheduler.updateTask('done', { priority: 9 })).rejects.toBeInstanceOf(
      TerminalTaskError,
    );
    expect(scheduler.getTask('done')!.priority).toBe(1); // unchanged
  });

  it('dependency updates on a running task are rejected; scalar updates allowed', async () => {
    const { scheduler, clock } = makeScheduler();
    await scheduler.addTask({ id: 'run' });
    const res = await scheduler.executeNextTask();
    expect(res.kind).toBe('running');
    await expect(scheduler.updateTask('run', { dependencies: [] })).rejects.toBeInstanceOf(
      InvalidStatusError,
    );
    await scheduler.updateTask('run', { priority: 7 });
    expect(scheduler.getTask('run')!.priority).toBe(7);
    await scheduler.completeTask('run', clock.value);
  });
});

describe('TaskScheduler — cycle detection', () => {
  it('wouldCreateCycle detects cycles via reachable-path BFS', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    // Edge A → B would close the loop A → B → A.
    expect(scheduler.wouldCreateCycle('A', 'B')).toBe(true);
    expect(scheduler.wouldCreateCycle('A', 'C')).toBe(false); // C unknown: no path
  });

  it('wouldCreateCycle is false for non-cyclic edges', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    // Edge B → A' : BFS from A' finds no path back to B.
    expect(scheduler.wouldCreateCycle('B', 'A')).toBe(false);
  });

  it('self-dependency rejected with cycle evidence', async () => {
    const { scheduler } = makeScheduler();
    const p = await scheduler
      .addTask({ id: 'a', dependencies: ['a'] })
      .catch((e) => e);
    expect(p).toBeInstanceOf(CycleError);
    expect((p as CycleError).code).toBe('CYCLE_DETECTED');
    expect((p as CycleError).cycle).toEqual(['a', 'a']);
    expect(scheduler.getTask('a')).toBeUndefined();
  });

  it('addTask rejects cycle-creating dependencies with a witness path', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.addTask({ id: 'C', dependencies: ['B'] });
    // Phase 1: new task D depending on C — no cycle yet (D unreachable
    // from C), so the addition is accepted.
    await scheduler.addTask({ id: 'D', dependencies: ['C'] });
    // Phase 2: C gaining a dependency on D closes the loop
    // C → D → C and must be rejected with the witness path.
    const err = await scheduler
      .updateTask('C', { dependencies: ['B', 'D'] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CycleError);
    expect((err as CycleError).cycle).toEqual(['D', 'C', 'D']);
    expect(scheduler.getTask('C')!.dependencies.has('D')).toBe(false); // graph untouched
  });

  it('hasCycle detects planted cycles and extracts the witness path', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.addTask({ id: 'C', dependencies: ['B'] });
    // Plant a genuine cycle outside the validated API (simulating
    // external corruption): A → C → B → A.
    (scheduler.getTask('C')!.dependencies as Set<string>).add('A');
    (scheduler.getTask('A')!.dependencies as Set<string>).add('C');
    const report = await scheduler.hasCycle();
    expect(report.hasCycle).toBe(true);
    expect(report.cycle).toEqual(['A', 'C', 'B', 'A']);
  });

  it('hasCycle reports clean graphs as acyclic', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.addTask({ id: 'C', dependencies: ['B'] });
    const report = await scheduler.hasCycle();
    expect(report.hasCycle).toBe(false);
    expect(report.cycle).toBeUndefined();
    expect(scheduler.getMetrics().cycleAudits).toBe(1);
  });
});

describe('TaskScheduler — execution', () => {
  it('runner success auto-completes and unblocks dependents', async () => {
    const onTaskCompleted = vi.fn(async () => {});
    const onTaskUnblocked = vi.fn(async () => {});
    const { scheduler } = makeScheduler({
      runner: async (task: Task) => {},
      hooks: { onTaskCompleted, onTaskUnblocked },
    });
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    const res = await scheduler.executeNextTask();
    expect(res.kind).toBe('executed');
    expect(asExecuted(res).task.id).toBe('A');
    expect(asExecuted(res).error).toBeUndefined();
    expect(asExecuted(res).durationMs).toBeGreaterThanOrEqual(0);
    expect(scheduler.getTask('A')!.status).toBe('COMPLETED');
    expect(scheduler.getTask('A')!.attempts).toBe(1);
    expect(scheduler.getTask('B')!.status).toBe('READY');
    expect(onTaskCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }));
    expect(onTaskUnblocked).toHaveBeenCalledWith(expect.objectContaining({ id: 'B' }));
    expect(scheduler.getMetrics().executed).toBe(1);
  });

  it('runner failure auto-fails and propagates downstream', async () => {
    const { scheduler } = makeScheduler({
      runner: async (task: Task) => {
        if (task.id === 'A') throw new Error('boom');
      },
    });
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.addTask({ id: 'C', dependencies: ['B'] });
    const res = await scheduler.executeNextTask();
    expect(res.kind).toBe('executed');
    expect(asExecuted(res).task.id).toBe('A');
    expect(asExecuted(res).error).toBe('boom');
    expect(scheduler.getTask('A')!.status).toBe('FAILED');
    expect(scheduler.getTask('B')!.status).toBe('FAILED');
    expect(scheduler.getTask('B')!.failureReason).toBe('execution_failed:boom');
    expect(scheduler.getTask('C')!.status).toBe('FAILED');
    expect(scheduler.getTask('C')!.failureReason).toBe('execution_failed:boom');
  });

  it('manual mode reserves RUNNING; explicit completion finalizes', async () => {
    const { scheduler, clock } = makeScheduler();
    await scheduler.addTask({ id: 'm' });
    const res = await scheduler.executeNextTask();
    expect(res.kind).toBe('running');
    if (res.kind !== 'running') throw new Error('unreachable');
    expect(scheduler.getTask('m')!.status).toBe('RUNNING');
    await scheduler.completeTask('m', clock.value);
    expect(scheduler.getTask('m')!.status).toBe('COMPLETED');
    await expect(scheduler.completeTask('m')).rejects.toBeInstanceOf(TerminalTaskError);
    await expect(scheduler.failTask('m')).rejects.toBeInstanceOf(TerminalTaskError);
  });

  it('completeTask refuses tasks with unmet dependencies', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await expect(scheduler.completeTask('B')).rejects.toBeInstanceOf(InvalidStatusError);
    expect(scheduler.getTask('B')!.status).toBe('PENDING'); // unchanged
  });
});

describe('TaskScheduler — lifecycle edge cases', () => {
  it('deleteTask propagates failure to all reachable dependents', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'A' });
    await scheduler.addTask({ id: 'B', dependencies: ['A'] });
    await scheduler.addTask({ id: 'C', dependencies: ['B'] });
    await scheduler.deleteTask('A');
    expect(scheduler.getTask('A')).toBeUndefined();
    expect(scheduler.getTask('B')!.status).toBe('FAILED');
    expect(scheduler.getTask('B')!.failureReason).toBe('upstream_deleted:A');
    expect(scheduler.getTask('C')!.status).toBe('FAILED');
    expect(scheduler.getTask('C')!.failureReason).toBe('upstream_deleted:A');
    expect(scheduler.getMetrics().deletions).toBe(1);
  });

  it('reset revives terminal tasks and preserves attempt history', async () => {
    let failures = 0;
    const { scheduler } = makeScheduler({
      runner: async (task: Task) => {
        if (failures < 1) {
          failures++;
          throw new Error('boom');
        }
      },
    });
    await scheduler.addTask({ id: 'r', priority: 3 });
    const first = await scheduler.executeNextTask();
    expect(first.kind).toBe('executed');
    expect(asExecuted(first).error).toBe('boom');
    expect(scheduler.getTask('r')!.status).toBe('FAILED');
    expect(scheduler.getTask('r')!.attempts).toBe(1);
    const revived = await scheduler.resetTask('r');
    expect(revived.status).toBe('READY');
    expect(revived.attempts).toBe(1); // history preserved
    expect(scheduler.getTask('r')!.failureReason).toBeUndefined();
    const second = await scheduler.executeNextTask();
    expect(second.kind).toBe('executed');
    expect(asExecuted(second).error).toBeUndefined();
    expect(scheduler.getTask('r')!.status).toBe('COMPLETED');
    expect(scheduler.getTask('r')!.attempts).toBe(2);
  });

  it('reset on a live task is rejected', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'live' });
    await expect(scheduler.resetTask('live')).rejects.toBeInstanceOf(InvalidStatusError);
  });

  it('clear() empties the scheduler and remains usable', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'a' });
    await scheduler.addTask({ id: 'b' });
    await scheduler.clear();
    expect(scheduler.getTask('a')).toBeUndefined();
    const m = scheduler.getMetrics();
    expect(m.totalTasks).toBe(0);
    expect(m.heapSize).toBe(0);
    expect(m.dependencyEdges).toBe(0);
    await scheduler.addTask({ id: 'c' }); // still fully usable
    expect(scheduler.getTask('c')!.status).toBe('READY');
  });

  it('dispose() rejects subsequent operations', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'a' });
    await scheduler.dispose();
    await expect(scheduler.addTask({ id: 'b' })).rejects.toBeInstanceOf(DisposedSchedulerError);
    expect(scheduler.getTask('a')).toBeUndefined();
  });
});

describe('TaskScheduler — concurrency', () => {
  it('concurrent ops run sequentially — never interleaved', async () => {
    const events: { id: string; phase: string; t: number }[] = [];
    const { scheduler } = makeScheduler({
      runner: async (task: Task) => {
        events.push({ id: task.id, phase: 'start', t: performance.now() });
        await new Promise((r) => setTimeout(r, 50)); // hold the window open
        events.push({ id: task.id, phase: 'end', t: performance.now() });
      },
    });
    await scheduler.addTask({ id: 'a', priority: 5 });
    await scheduler.addTask({ id: 'b', priority: 5 });
    events.length = 0;
    const [ra, rb] = await Promise.all([
      scheduler.executeNextTask(),
      scheduler.executeNextTask(),
    ]);
    const aEnd = Math.max(...events.filter((e) => e.id === 'a').map((e) => e.t));
    const bStart = Math.min(...events.filter((e) => e.id === 'b').map((e) => e.t));
    expect(ra.kind).toBe('executed');
    expect(rb.kind).toBe('executed');
    expect(asExecuted(ra).task.id).toBe('a');
    expect(asExecuted(rb).task.id).toBe('b');
    // Id tie-break orders 'a' above 'b'; submission order then guarantees
    // a completes before b starts — the no-interleave property.
    expect(aEnd).toBeLessThan(bStart);
  });

  it('reentrant calls run immediately — no circular wait', async () => {
    const { scheduler } = makeScheduler({
      runner: async (task: Task) => {
        const nested = await scheduler.addTask({ id: 'nested', dependencies: [task.id] });
        expect(nested.status).toBe('PENDING');
      },
    });
    await scheduler.addTask({ id: 'root', priority: 1 });
    const res = await scheduler.executeNextTask(); // must resolve — not hang
    expect(res.kind).toBe('executed');
    // The reentrant addition was registered under root's dependent set,
    // so root's completion unblocks it: final state is READY.
    expect(scheduler.getTask('nested')!.status).toBe('READY');
  }, 15_000);
});

describe('TaskScheduler — metrics', () => {
  it('counters track ground truth across mixed operations', async () => {
    const { scheduler } = makeScheduler({ runner: async (task: Task) => {} });
    await scheduler.addTask({ id: 'a' });
    await scheduler.addTask({ id: 'b', dependencies: ['a'] });
    const first = await scheduler.executeNextTask();
    expect(asExecuted(first).task.id).toBe('a');
    const second = await scheduler.executeNextTask();
    expect(asExecuted(second).task.id).toBe('b');
    const third = await scheduler.executeNextTask();
    expect(third.kind).toBe('none');
    const m = scheduler.getMetrics();
    expect(m.totalTasks).toBe(2);
    expect(m.byStatus).toEqual({
      PENDING: 0,
      READY: 0,
      RUNNING: 0,
      COMPLETED: 2,
      FAILED: 0,
      CANCELLED: 0,
    });
    expect(m.dependencyEdges).toBe(1);
    expect(m.executed).toBe(2);
    expect(m.unblocked).toBe(1);
    expect(m.upserts).toBe(2);
    expect(scheduler.auditMetrics().drift).toEqual([]);
  });

  it('auditMetrics reconciles counters against live state', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.addTask({ id: 'a' });
    expect(scheduler.auditMetrics().drift).toEqual([]); // healthy: no drift
    // Corrupt a counter (simulating a bookkeeping bug) — white-box access.
    const counters = (
      scheduler as unknown as {
        counters: {
          byStatus: Record<'PENDING' | 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', number>;
        };
      }
    ).counters;
    counters.byStatus.READY += 5;
    const audit = scheduler.auditMetrics();
    expect(audit.drift.some((d: string) => d.includes('byStatus.READY'))).toBe(true);
  });
});

describe('TaskScheduler — capacity', () => {
  it('addTask rejects beyond the configured capacity', async () => {
    const { scheduler } = makeScheduler({ maxTasks: 2 });
    await scheduler.addTask({ id: 't1' });
    await scheduler.addTask({ id: 't2' });
    await expect(scheduler.addTask({ id: 't3' })).rejects.toBeInstanceOf(CapacityExceededError);
    expect(scheduler.getTask('t3')).toBeUndefined();
    expect(scheduler.getMetrics().totalTasks).toBe(2);
  });
});

describe('TaskScheduler — hooks', () => {
  it('advisory hook failures are recorded, never thrown', async () => {
    const onTaskAdded = vi.fn(async () => {});
    const onTaskCompleted = vi.fn(async () => {
      throw new Error('hook-down');
    });
    const { scheduler } = makeScheduler({
      runner: async (task: Task) => {},
      hooks: { onTaskAdded, onTaskCompleted },
    });
    const task = await scheduler.addTask({ id: 'h' });
    expect(onTaskAdded).toHaveBeenCalledWith(task);
    const res = await scheduler.executeNextTask();
    expect(res.kind).toBe('executed');
    expect(scheduler.getTask('h')!.status).toBe('COMPLETED'); // state committed despite hook failure
    const m = scheduler.getMetrics();
    expect(m.hookErrors).toBe(1);
    expect(m.lastError).toContain('onTaskCompleted');
  });
});
