/**
 * Standalone scheduler benchmark.
 *
 * Run:  npm run bench [taskCount] [executionCount]
 *       (defaults: 100_000 tasks, 5_000 executions)
 *
 * Generates a deterministic binary-tree-like DAG (task i depends on
 * floor(i/2), plus floor(i/3) for every seventh task — always
 * pointing at earlier tasks, so the graph is acyclic by
 * construction), registers it through the serialized API, then
 * executes tasks with a no-op runner while verifying against an
 * independent ground-truth simulation of the dependency graph.
 *
 * Prints a report: registration throughput, execution latency,
 * memory footprint, heap consistency, metrics/audit latency.
 */
import { performance } from 'node:perf_hooks';
import { TaskScheduler } from '../src/scheduler';
import { generateTaskInputs } from '../tests/helpers/generate';

const count = Number(process.argv[2] ?? process.env.BENCH_COUNT ?? 100_000);
const executions = Number(process.argv[3] ?? process.env.BENCH_EXECUTIONS ?? 5_000);

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

async function main(): Promise<void> {
  const t0 = Date.now();
  let now = t0;
  const graph = generateTaskInputs(count, t0);
  const scheduler = new TaskScheduler({
    nowProvider: () => now,
    runner: async () => {
      /* no-op work */
    },
  });

  // Phase 1 — registration.
  const heap0 = process.memoryUsage().heapUsed;
  const addStart = performance.now();
  const createdAts: number[] = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    now += 1;
    createdAts[i] = now;
    await scheduler.addTask(graph.inputs[i]!);
  }
  const addWallMs = performance.now() - addStart;
  const rss = process.memoryUsage().rss;
  const heap1 = process.memoryUsage().heapUsed;

  // Phase 2 — ground truth.
  const simTasks: SimTask[] = graph.inputs.map((input, i) => ({
    index: i,
    id: input.id,
    priority: input.priority ?? 0,
    createdAt: createdAts[i]!,
  }));
  const completed = new Set<number>();
  let candidates: SimTask[] = graph.depOf
    .map((deps, i) => ({ deps, i }))
    .filter(({ deps }) => deps.length === 0)
    .map(({ i }) => simTasks[i]!);
  now = t0 + count; // every executeTime is now <= clock

  // Phase 3 — execution with ground-truth verification.
  const execStart = performance.now();
  let mismatch = 0;
  for (let step = 0; step < executions; step++) {
    let best: SimTask | undefined;
    for (const c of candidates) {
      if (best === undefined || beats(c, best)) best = c;
    }
    if (best === undefined) {
      console.error(`step ${step}: candidate set empty — stopping`);
      break;
    }
    const res = await scheduler.executeNextTask(now);
    const chosenIdx = best!.index;
    if (res.kind !== 'executed') {
      mismatch++;
      console.error(`step ${step}: kind ${res.kind} (expected executed)`);
    } else if (res.task.id !== best!.id) {
      mismatch++;
      console.error(`step ${step}: scheduler chose ${res.task.id}, expected ${best!.id}`);
    }
    completed.add(chosenIdx);
    candidates = candidates.filter((c) => c.index !== chosenIdx);
    for (const dependent of graph.dependentsOf[chosenIdx] ?? []) {
      const dep = graph.depOf[dependent]!;
      if (!completed.has(dependent) && dep.every((d) => completed.has(d))) {
        candidates.push(simTasks[dependent]!);
      }
    }
  }
  const execWallMs = performance.now() - execStart;
  const edgeCount = graph.depOf.reduce((sum, deps) => sum + deps.length, 0);

  console.log(
    [
      '',
      `══ BENCHMARK REPORT — ${count} tasks ══`,
      `add:       ${count} tasks in ${addWallMs.toFixed(1)} ms (${(addWallMs / count).toFixed(2)} ms/task)`,
      `memory:     heap delta +${(heap1 - heap0) / 1048576} MiB (RSS ${Math.round(rss / 1048576)} MiB)`,
      `edges:      ${edgeCount} dependency edges`,
      `execute:    ${completed.size} executions in ${execWallMs.toFixed(1)} ms (${(execWallMs / Math.max(1, completed.size)).toFixed(2)} ms/call)`,
      `mismatches: ${mismatch} (expected 0)`,
      `heap:       ${scheduler.getMetrics().heapSize} READY entries vs ${candidates.length} ground-truth candidates`,
      ``,
    ].join('\n'),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
