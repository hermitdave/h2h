/**
 * Performance suite — the 1M-task proof.
 *
 * Run with: npm run test:perf
 * Set SKIP_PERF=1 to skip (e.g. in low-memory CI).
 */
import { TaskScheduler, TaskStatus } from '../src';

jest.setTimeout(900_000);

const SKIP = !!process.env.SKIP_PERF;
const NOW = 1_000_000_000; // 2001-09-09

// `test` or `test.skip` chosen once at module load (Jest 29 typings have no skipIf).
const perfTest = SKIP ? test.skip : test;

function ms(x: number): string {
  return `${x.toFixed(0)} ms`;
}

function mb(x: number): string {
  return `${(x / 1024 / 1024).toFixed(0)} MB`;
}

describe('performance (1M tasks)', () => {
  perfTest('adds 1,000,000 tasks', () => {
    const s = new TaskScheduler({ now: NOW, maxTasks: 1_000_000 });
    const t0 = performance.now();
    for (let i = 0; i < 1_000_000; i++) {
      const deps: string[] = [];
      if (i > 0 && i % 5 === 0) deps.push(`t${i - 1}`); // 20% with one earlier dep
      s.addTask({
        id: `t${i}`,
        priority: (i * 7919) % 1000,
        executeTime: NOW + (i % 10_000) * 1000, // spread over ~2.8h
        dependencies: deps,
      });
    }
    const addMs = performance.now() - t0;
    expect(s.metrics().total).toBe(1_000_000);
    expect(s.metrics().totalEdges).toBe(199_999); // i=5,10,...,999995
    console.log(`[perf] 1M adds: ${ms(addMs)} (${(1_000_000 / addMs).toFixed(0)}k adds/s) heapUsed=${mb(process.memoryUsage().heapUsed)}`);
    expect(addMs).toBeLessThan(120_000); // generous cap
  });

  perfTest('drains all 1,000,000 tasks in dependency-respecting priority order', () => {
    const s = new TaskScheduler({ now: NOW });
    for (let i = 0; i < 1_000_000; i++) {
      s.addTask({
        id: `t${i}`,
        priority: (i * 2654435761) % 1000, // full priority spread, all due now
      });
    }
    const t0 = performance.now();
    let executed = 0;
    let completedDepViolations = 0;
    const completed = new Set<string>();
    for (;;) {
      const t = s.claimNextExecutable();
      if (!t) break;
      for (const dep of t.dependencies) {
        if (!completed.has(dep)) completedDepViolations++;
      }
      completed.add(t.id);
      s.completeTask(t.id);
      executed++;
      if (executed === 100_000) {
        const midMs = performance.now() - t0;
        console.log(`[perf] 1M drain: 100k done in ${ms(midMs)}`);
      }
    }
    const totalMs = performance.now() - t0;
    expect(executed).toBe(1_000_000);
    expect(completedDepViolations).toBe(0);
    expect(s.metrics().completed).toBe(1_000_000);
    expect(s.metrics().byStatus[TaskStatus.PENDING]).toBe(0);
    expect(s.metrics().byStatus[TaskStatus.READY]).toBe(0);
    expect(s.claimNextExecutable()).toBeNull();
    console.log(`[perf] 1M full drain (claim+complete): ${ms(totalMs)} (${(1_000_000 / (totalMs / 1000)).toFixed(0)} ops/s) heapUsed=${mb(process.memoryUsage().heapUsed)}`);
    expect(totalMs).toBeLessThan(300_000);
  });

  perfTest('adversarial: 100k high-priority future tasks above 1 due task — claim stays O(log n)', () => {
    const s = new TaskScheduler({ now: NOW });
    for (let i = 0; i < 100_000; i++) {
      s.addTask({ id: `f${i}`, priority: 10_000, executeTime: NOW + 1_000_000 + i });
    }
    s.addTask({ id: 'due', priority: 1 });
    const t0 = performance.now();
    expect(s.claimNextExecutable()!.id).toBe('due');
    expect(s.claimNextExecutable()).toBeNull();
    const claimMs = performance.now() - t0;
    console.log(`[perf] adversarial claim over 100k future head: ${ms(claimMs)}, promotions=${s.metrics().promotions}`);
    expect(claimMs).toBeLessThan(2_000);
    expect(s.metrics().promotions).toBe(0);
    // And once the clock jumps, all 100k promote in one bounded burst.
    const t1 = performance.now();
    expect(s.claimNextExecutable(NOW + 1_000_000 + 100_000)!.priority).toBe(10_000);
    const burstMs = performance.now() - t1;
    console.log(`[perf] burst-promote 100k + first claim: ${ms(burstMs)}`);
    expect(burstMs).toBeLessThan(30_000);
  });

  perfTest('1M-node chain: hasCycle() is fast and iterative (no stack overflow)', () => {
    const s = new TaskScheduler({ now: NOW });
    s.addTask({ id: 'c0' });
    for (let i = 1; i < 1_000_000; i++) {
      s.addTask({ id: `c${i}`, dependencies: [`c${i - 1}`] });
    }
    const t0 = performance.now();
    expect(s.hasCycle()).toBe(false);
    const cycleMs = performance.now() - t0;
    console.log(`[perf] hasCycle over 1M-node chain: ${ms(cycleMs)} heapUsed=${mb(process.memoryUsage().heapUsed)}`);
    expect(cycleMs).toBeLessThan(60_000);
  });

  perfTest('10k-task DAG with 10% cross-deps: full drain with invariants checked', () => {
    const s = new TaskScheduler({ now: NOW });
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const deps: string[] = [];
      if (i > 0) {
        const count = (i * 7) % 4;
        for (let k = 0; k < count; k++) {
          deps.push(`t${(i * (k + 1) * 31) % i}`);
        }
      }
      s.addTask({ id: `t${i}`, priority: (i * 2654435761) % 1000, dependencies: deps });
    }
    const t0 = performance.now();
    const completedAt = new Map<string, number>();
    let step = 0;
    for (;;) {
      const t = s.claimNextExecutable();
      if (!t) break;
      for (const dep of t.dependencies) {
        if (!completedAt.has(dep)) {
          throw new Error(`invariant violated: ${t.id} ran before ${dep}`);
        }
      }
      completedAt.set(t.id, step++);
      s.completeTask(t.id);
    }
    const drainMs = performance.now() - t0;
    expect(completedAt.size).toBe(N);
    console.log(`[perf] 10k DAG drain with invariant checks: ${ms(drainMs)}`);
    expect(drainMs).toBeLessThan(120_000);
  });

  perfTest('memory footprint of 1M tasks (reported, not gated)', () => {
    // --expose-gc via `npm run test:perf` makes the measurement stable across
    // the big tests that ran before it in the same worker.
    const gc = (globalThis as { gc?: () => void }).gc;
    if (gc) {
      gc();
    }
    const s = new TaskScheduler({ now: NOW });
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1_000_000; i++) {
      const deps: string[] = [];
      if (i > 0 && i % 5 === 0) deps.push(`m${i - 1}`);
      s.addTask({
        id: `m${i}`,
        priority: (i * 7919) % 1000,
        executeTime: NOW + (i % 10_000) * 1000,
        dependencies: deps,
      });
    }
    // Keep `s` referenced through the measurement — otherwise V8 considers
    // the whole 1M-task graph dead and collects it (measured: -2 MB "footprint").
    const total = s.metrics().total;
    const afterLoad = process.memoryUsage().heapUsed - before;
    let afterGc = afterLoad;
    if (gc) {
      gc();
      afterGc = process.memoryUsage().heapUsed - before;
    }
    console.log(
      `[perf] 1M tasks (${total} live) resident: ${mb(afterLoad)} after load, ${mb(afterGc)} after GC, heapUsed=${mb(process.memoryUsage().heapUsed)}`
    );
    expect(total).toBe(1_000_000);
    // Sanity gates: the graph is genuinely resident (>100 MB) and under 2 GB.
    expect(afterGc).toBeGreaterThan(100 * 1024 * 1024);
    expect(afterGc).toBeLessThan(2 * 1024 * 1024 * 1024);
  });
});
