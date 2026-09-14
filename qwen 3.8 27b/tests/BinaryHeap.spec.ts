import { BinaryHeap, type HeapElement } from '../src/BinaryHeap';

interface Item extends HeapElement {
  id: string;
  priority: number;
  time: number;
}

// Same ordering the scheduler uses for its due heap.
const cmp: (a: Item, b: Item) => number = (a, b) =>
  b.priority - a.priority || a.time - b.time;

function make(items: Array<[string, number, number]>): BinaryHeap<Item> {
  const heap = new BinaryHeap<Item>(cmp);
  for (const [id, priority, time] of items) {
    heap.push({ id, priority, time });
  }
  return heap;
}

function drained(heap: BinaryHeap<Item>): Item[] {
  const out: Item[] = [];
  while (!heap.isEmpty()) out.push(heap.pop());
  return out;
}

describe('BinaryHeap', () => {
  test('pops in comparator order (priority desc, time asc)', () => {
    const heap = make([
      ['a', 1, 100],
      ['b', 5, 100],
      ['c', 5, 50],
      ['d', 5, 500],
      ['e', 9, 999],
    ]);
    const order = drained(heap).map((t) => t.id);
    expect(order).toEqual(['e', 'c', 'b', 'd', 'a']);
  });

  test('heapify builds a correct heap in bulk', () => {
    const heap = new BinaryHeap<Item>(cmp);
    const items: Item[] = [];
    for (let i = 0; i < 1000; i++) {
      items.push({ id: `t${i}`, priority: (i * 37) % 100, time: (i * 91) % 997 });
    }
    heap.heapify(items);
    expect(heap.size).toBe(1000);
    const out = drained(heap);
    for (let i = 1; i < out.length; i++) {
      expect(cmp(out[i - 1]!, out[i]!)).toBeLessThanOrEqual(0);
    }
  });

  test('remove arbitrary element preserves order', () => {
    const heap = make([
      ['a', 1, 0],
      ['b', 2, 0],
      ['c', 3, 0],
      ['d', 4, 0],
      ['e', 5, 0],
    ]);
    expect(heap.remove('e')!.id).toBe('e'); // was root
    expect(heap.remove('b')!.id).toBe('b'); // middle
    expect(heap.remove('a')!.id).toBe('a'); // bottom
    expect(drained(heap).map((t) => t.id)).toEqual(['d', 'c']);
  });

  test('remove absent id returns null and is a no-op', () => {
    const heap = make([['a', 1, 0]]);
    expect(heap.remove('nope')).toBeNull();
    expect(heap.size).toBe(1);
    expect(heap.peek()!.id).toBe('a');
  });

  test('peek, size, isEmpty, contains, indexOf', () => {
    const heap = make([['a', 1, 0], ['b', 2, 0]]);
    expect(heap.isEmpty()).toBe(false);
    expect(heap.size).toBe(2);
    expect(heap.peek()!.id).toBe('b');
    expect(heap.contains('a')).toBe(true);
    expect(heap.indexOf('a')).toBeGreaterThanOrEqual(0);
    expect(heap.indexOf('zz')).toBe(-1);
    expect(heap.isEmpty()).toBe(false);
    heap.pop();
    heap.pop();
    expect(heap.isEmpty()).toBe(true);
    expect(heap.peek()).toBeNull();
  });

  test('pop from empty throws', () => {
    const heap = new BinaryHeap<Item>(cmp);
    expect(() => heap.pop()).toThrow(/empty/);
  });

  test('duplicate id push throws', () => {
    const heap = make([['a', 1, 0]]);
    expect(() => heap.push({ id: 'a', priority: 2, time: 0 })).toThrow(/duplicate/);
  });

  test('re-push after remove works', () => {
    const heap = make([['a', 1, 0]]);
    heap.remove('a');
    heap.push({ id: 'a', priority: 9, time: 0 });
    expect(heap.peek()!.id).toBe('a');
    expect(heap.peek()!.priority).toBe(9);
  });

  test('clear empties the heap', () => {
    const heap = make([['a', 1, 0], ['b', 2, 0]]);
    heap.clear();
    expect(heap.size).toBe(0);
    expect(heap.contains('a')).toBe(false);
  });

  test('50k pushes and pops stay sorted', () => {
    const heap = new BinaryHeap<Item>(cmp);
    for (let i = 0; i < 50_000; i++) {
      heap.push({ id: `t${i}`, priority: (i * 7919) % 1000, time: (i * 104729) % 100_000 });
    }
    const out = drained(heap);
    expect(out.length).toBe(50_000);
    for (let i = 1; i < out.length; i++) {
      expect(cmp(out[i - 1]!, out[i]!)).toBeLessThanOrEqual(0);
    }
  });
});
