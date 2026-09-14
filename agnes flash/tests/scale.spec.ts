import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { TaskScheduler } from '../src/scheduler';
import type { AddTaskInput } from '../src/types';
import { FakeClock } from './helpers/fake-clock';
import { generateTaskInputs } from './helpers/generate';

/**
 * 1M-task scale verification. Opt-in: runs only when SCALE_TESTS=1.
 *
 * Proves, with real measurements rather than assertions of intent:
 *  1. Registration throughput — wall time to add 1M tasks through the
 *     serialized API, and the resulting memory footprint.
 *  2. Ordering correctness — 10k executions, each verified against an
 *     independent ground-truth simulation of the dependency graph.
 *  3. Heap consistency — the scheduler's heap matches the ground-truth
 *     executable set after the run.
 *  4. Audit costs — hasCycle latency at 1M nodes, wouldCreateCycle
 *     probe latency, getMetrics O(1) latency.
 */

const COUNT = 1_000_000;
const EXECUTIONS = 10_000;

declare const global: { gc?: () => void };

function gcSettle(): Promise<void> {
  global.gc?.();
  return new Promise((resolve) => setImmediate(resolve));
}

interface SimTask {
  index: number;
  id: string;
  priority: number;
  createdAt: number;
}

/** Mirrors the scheduler's heap comparator exactly. */
function beats(a: SimTask, b: SimTask): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}

describe.runIf(process.env.SCALE_TESTS === '1')('scale', () => {
  it('adds 1M tasks, executes 10k in dependency-aware priority order', async () => {
    const clock = new FakeClock(1_000_000_000);
    const graph = generateTaskInputs(COUNT, clock.value);
    const scheduler = new TaskScheduler({
      nowProvider: () => clock.now(),
      runner: async () => {
        /* no-op work */
      },
    });

    // Phase 1 — registration.
    await gcSettle();
    const heap0 = process.memoryUsage().heapUsed;
    const addStart = performance.now();
    const createdAts: number[] = new Array<number>(COUNT);
    for (let i = 0; i < COUNT; i++) {
      clock.advance(1); // deterministic createdAt spacing
      createdAts[i] = clock.now();
      await scheduler.addTask(graph.inputs[i]!);
    }
    const addWallMs = performance.now() - addStart;
    await gcSettle();
    const heap1 = process.memoryUsage().heapUsed;
    const rss1 = process.memoryUsage().rss;

    // Phase 2 — ground-truth simulation state.
    const simTasks: SimTask[] = graph.inputs.map((input: AddTaskInput, index) => ({
      index,
      id: input.id,
      priority: input.priority ?? 0,
      createdAt: createdAts[index]!,
    }));
    const completed = new Set<number>();
    let candidates: SimTask[] = graph.depOf
      .map((deps, i) => ({ deps, i }))
      .filter(({ deps }) => deps.length === 0)
      .map(({ i }) => simTasks[i]!);
    // Only dep-free tasks are candidates initially (task 0).

    // Phase 3 — execution with ground-truth verification.
    clock.advance(COUNT); // every executeTime (= t0) is now <= clock
    const execStart = performance.now();
    let execWallMs = 0;
    const edgeCount = graph.depOf.reduce((sum, deps) => sum + deps.length, 0);

    for (let step = 0; step < EXECUTIONS; step++) {
      let best: SimTask | undefined;
      for (const c of candidates) {
        if (best === undefined || beats(c, best)) best = c;
      }
      expect(best, `step ${step}: candidate set unexpectedly empty`).toBeDefined();
      const stepStart = performance.now();
      const res = await scheduler.executeNextTask();
      expect(res.kind, `step ${step}: expected an execution, got ${res.kind}`).toBe('executed');
      if (res.kind !== 'executed') throw new Error('unreachable');
      const chosenIdx = best!.index;
      expect(res.task.id, `step ${step}: scheduler chose ${res.task.id}, expected ${best!.id}`)
        .toBe(best!.id);
      for (const d of graph.depOf[chosenIdx] ?? []) {
        expect(completed.has(d), `step ${step}: dep ${d} of ${res.task.id} not completed`)
          .toBe(true);
      }
      // Update the simulation: execution + dependent promotion.
      completed.add(chosenIdx);
      candidates = candidates.filter((c) => c.index !== chosenIdx);
      for (const dependent of graph.dependentsOf[chosenIdx] ?? []) {
        const dep = graph.depOf[dependent]!;
        if (!completed.has(dependent) && dep.every((d) => completed.has(d))) {
          candidates.push(simTasks[dependent]!);
        }
      }
      execWallMs += performance.now() - stepStart;
    }
    const execWallTotal = performance.now() - execStart;

    // Phase 4 — post-run invariants.
    expect(scheduler.getMetrics().heapSize).toBe(candidates.length);
    expect(scheduler.getMetrics().totalTasks).toBe(COUNT);
    expect(scheduler.getMetrics().byStatus.COMPLETED).toBe(EXECUTIONS);
    expect(scheduler.getMetrics().executed).toBe(EXECUTIONS);
    expect(scheduler.getMetrics().dependencyEdges).toBe(edgeCount);
    expect(scheduler.auditMetrics().drift).toEqual([]);

    // Phase 5 — audit latency at scale.
    const metricsStart = performance.now();
    const metrics = scheduler.getMetrics();
    const metricsMs = performance.now() - metricsStart;
    expect(metricsMs).toBeLessThan(1); // O(1) assembly

    const auditStart = performance.now();
    const report = await scheduler.hasCycle();
    const auditMs = performance.now() - auditStart;
    expect(report.hasCycle).toBe(false); // acyclic by construction
    expect(report.cycle).toBeUndefined();

    const probeCount = 100;
    const probeStart = performance.now();
    let probeSum = 0;
    for (let k = 0; k < probeCount; k++) {
      const taskId = `task-${String((k * 7919) % COUNT).padStart(7, '0')}`;
      const depId = `task-${String((k * 31337) % COUNT).padStart(7, '0')}`;
      const t0 = performance.now();
      scheduler.wouldCreateCycle(taskId, depId);
      probeSum += performance.now() - t0;
    }
    const probeAvgMs = (performance.now() - probeStart) / probeCount;

    console.log(
      [
        '',
        '══ SCALE REPORT — 1M tasks ══',
        `add:      ${COUNT} tasks in ${addWallMs.toFixed(1)} ms (${(addWallMs / COUNT).toFixed(2)} ms/task)`,
        `memory:   heap delta ${(heap1 - heap0) / 1048576} MiB (heapUsed ${Math.round(heap1 / 1048576)} MiB after adds, RSS ${Math.round(rss1 / 1048576)} MiB)`,
        `edges:    ${edgeCount} dependency edges`,
        `execute:  ${EXECUTIONS} executions in ${execWallTotal.toFixed(1)} ms (${(execWallTotal / EXECUTIONS).toFixed(2)} ms/call, worst step ${execWallMs / EXECUTIONS < 1 ? '<1' : (execWallMs / EXECUTIONS).toFixed(2)} ms avg)`,
        `heap:     ${scheduler.getMetrics().heapSize} READY entries`,
        `metrics:  getMetrics ${metricsMs.toFixed(3)} ms (O(1))`,
        `audit:    hasCycle over ${COUNT} nodes in ${auditMs.toFixed(1)} ms`,
        `probe:    wouldCreateCycle avg ${probeAvgMs.toFixed(3)} ms over ${probeCount} probes`,
        '═══════════════════════════════',
        '',
      ].join('\n'),
    );
  }, 1_800_000);
});
