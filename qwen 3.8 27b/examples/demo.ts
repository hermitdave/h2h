/**
 * End-to-end demo: a small release pipeline.
 * Run: npm run demo   (builds, then node dist/examples/demo.js)
 */
import { TaskScheduler, TaskStatus } from '../src';

const s = new TaskScheduler({
  now: 0,
  onTaskClaimed: (t) => console.log(`  ▶ claimed ${t.id} (p=${t.priority})`),
  onTaskCompleted: (t) => console.log(`  ✓ completed ${t.id}`),
});

// Release pipeline:
//   deps:  lint ──┬─▶ build ─▶ test ─▶ deploy
//                └─▶ assets ─┘        (build also needs assets? no — test needs both)
s.addTask({ id: 'lint', priority: 10, payload: { step: 'lint' } });
s.addTask({ id: 'build', priority: 5, dependencies: ['lint'], executeTime: 100 });
s.addTask({ id: 'assets', priority: 5, dependencies: ['lint'] });
s.addTask({ id: 'test', priority: 5, dependencies: ['build', 'assets'], executeTime: 50 });
s.addTask({ id: 'deploy', priority: 9, dependencies: ['test'], executeTime: 200 });

console.log('Pipeline added. Wake timeline:', s.nextWakeTime());

// Try to sneak a cycle in (dynamic update) — rejected atomically:
try {
  s.updateTask('lint', { dependencies: ['deploy'] });
} catch (e) {
  console.log(`  ✗ update rejected: ${(e as Error).message}`);
}

// Run everything, advancing the clock as needed:
let guard = 0;
for (;;) {
  const t = s.claimNextExecutable();
  if (!t) {
    const wake = s.nextWakeTime();
    if (wake === null) break;
    s.peekNextExecutable(wake); // advance clock to next due time
    continue;
  }
  s.completeTask(t.id);
  if (++guard > 100) break;
}

console.log('\nFinal metrics:', JSON.stringify(s.metrics(), null, 2));
console.log('Blocked tasks:', JSON.stringify(s.getBlockedTasks()));
console.log('Cycle present?', s.hasCycle());

// Fail-safe demo: a failed task blocks its dependents
const s2 = new TaskScheduler({ now: 0 });
s2.addTask({ id: 'fetch' });
s2.addTask({ id: 'report', dependencies: ['fetch'] });
s2.failTask('fetch', new Error('network down'));
console.log('\nFail-safe: report blocked after fetch failed →',
  JSON.stringify(s2.getBlockedTasks().map((b) => ({ id: b.task.id, missing: b.missing }))));
s2.updateTask('report', { dependencies: [] }); // operator unblocks it
s2.claimNextExecutable();
console.log('After operator fix, report status:', s2.getTask('report')!.status);
