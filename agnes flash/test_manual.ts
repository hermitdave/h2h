import { TaskScheduler } from './src/scheduler';

async function test() {
  // Test 1: Basic CRUD
  const s = new TaskScheduler({ now: 1000 });
  await s.addTask({ id: 'a', priority: 5 });
  console.log('a status:', s.getTask('a')!.status);
  
  // Test 2: Dependencies
  await s.addTask({ id: 'b', priority: 5, dependencies: ['a'] });
  console.log('b status:', s.getTask('b')!.status);
  
  // Test 3: Execute
  const result = await s.executeNextTask();
  console.log('executeNextTask:', result.kind, result.kind === 'executed' || result.kind === 'running' ? result.task.id : '');
  
  // Test 4: Complete
  await s.completeTask('a');
  console.log('b status after a complete:', s.getTask('b')!.status);
  
  // Test 5: Forward references (disabled by default)
  const s2 = new TaskScheduler({ now: 0, allowForwardRefs: true });
  await s2.addTask({ id: 'future', dependencies: ['ghost'] });
  console.log('future status with forward ref:', s2.getTask('future')!.status);
  await s2.addTask({ id: 'ghost' });
  console.log('future status after ghost added:', s2.getTask('future')!.status);
  
  // Test 6: Reset task
  const s3 = new TaskScheduler({ now: 0 });
  await s3.addTask({ id: 'a' });
  await s3.cancelTask('a');
  console.log('a status after cancel:', s3.getTask('a')!.status);
  await s3.resetTask('a');
  console.log('a status after reset:', s3.getTask('a')!.status);
  
  // Test 7: Failure propagation
  const s4 = new TaskScheduler({ now: 0 });
  await s4.addTask({ id: 'root' });
  await s4.addTask({ id: 'child', dependencies: ['root'] });
  await s4.addTask({ id: 'grandchild', dependencies: ['child'] });
  await s4.failTask('root', 'boom');
  console.log('child status after root fails:', s4.getTask('child')!.status);
  console.log('grandchild status after root fails:', s4.getTask('grandchild')!.status);
  
  // Test 8: Audit metrics
  console.log('drift:', s4.auditMetrics().drift);
}

test().catch(console.error);
