import { TaskScheduler, TaskStatus, CycleError, InvalidTaskError, StaleVersionError } from './src/index';

// Test 1: Cycle detection through updateTask
const s = new TaskScheduler({ now: 1000 });
s.addTask({ id: 'a', executeTime: 1000 });
s.addTask({ id: 'b', executeTime: 1000, dependencies: ['a'] });
s.addTask({ id: 'c', executeTime: 1000, dependencies: ['b'] });

try {
  s.updateTask('a', { dependencies: ['c'] });
  console.log('BUG: cycle not detected');
} catch (e: any) {
  console.log('Cycle correctly detected:', e.message);
}

// Test 2: Fan-out performance
const s2 = new TaskScheduler({ now: 0 });
s2.addTask({ id: 'root', executeTime: 0 });
for (let i = 0; i < 1000; i++) {
  s2.addTask({ id: `child_${i}`, executeTime: 0, dependencies: ['root'] });
}
s2.completeTask('root');
console.log('Ready tasks after completing root:', s2.getReadyTasks().length);

// Test 3: Dependency update
const s3 = new TaskScheduler({ now: 0 });
s3.addTask({ id: 'x', executeTime: 0 });
s3.addTask({ id: 'y', executeTime: 0 });
s3.updateTask('y', { dependencies: ['x'] });
console.log('y status after adding dep:', s3.getTask('y')!.status);
console.log('y unmet deps:', s3.getTask('y')!.unmetDependencies);

// Test 4: Claim and complete
const s4 = new TaskScheduler({ now: 0 });
s4.addTask({ id: 'p', executeTime: 0, priority: 5 });
s4.addTask({ id: 'q', executeTime: 0, priority: 10 });
s4.addTask({ id: 'r', executeTime: 0, dependencies: ['p', 'q'] });
console.log('First claim:', s4.claimNextExecutable()!.id, '(expected q)');
console.log('Second claim:', s4.claimNextExecutable()!.id, '(expected p)');
s4.completeTask('p');
s4.completeTask('q');
console.log('Third claim:', s4.claimNextExecutable()!.id, '(expected r)');

// Test 5: Delete task
const s5 = new TaskScheduler({ now: 0 });
s5.addTask({ id: 'a', executeTime: 0 });
s5.addTask({ id: 'b', executeTime: 0, dependencies: ['a'] });
s5.deleteTask('a');
console.log('After deleting a, b status:', s5.getTask('b')!.status, '(expected PENDING with dangling dep)');
console.log('Blocked tasks:', s5.getBlockedTasks().length);

// Test 6: Optimistic concurrency control
const s6 = new TaskScheduler({ now: 0 });
s6.addTask({ id: 'a', executeTime: 0 });
s6.updateTask('a', { priority: 5 });
try {
  s6.updateTask('a', { priority: 10 }, 0); // stale version
  console.log('BUG: stale version not detected');
} catch (e: any) {
  console.log('Stale version correctly rejected:', e.message);
}

// Test 7: Re-add deleted task
const s7 = new TaskScheduler({ now: 0 });
s7.addTask({ id: 'a', executeTime: 0 });
s7.addTask({ id: 'b', executeTime: 0, dependencies: ['a'] });
s7.deleteTask('a');
s7.addTask({ id: 'a', executeTime: 0 }); // re-add
s7.completeTask('a');
console.log('After re-adding a and completing, b status:', s7.getTask('b')!.status, '(expected READY)');
