/**
 * Indexed binary max-heap.
 *
 * Entries are unique keys (the scheduler passes task ids). An internal
 * index map provides O(1) location of any entry's position, which gives
 * O(log n) removal of arbitrary entries and in-place re-sifting of
 * updated keys — the properties the scheduler relies on for dynamic
 * priority/executeTime updates.
 *
 * Ordering contract: `compare(a, b) < 0` means `a` sorts closer to the
 * root than `b`; the root is therefore the "best" entry.
 *
 * All sift operations return the entry's final index so that chained
 * sifts (up, then down) operate on the entry's true position — a plain
 * double-sift from the original index would operate on a different
 * entry after the first sift has swapped it.
 */
export class BinaryHeap<T> {
  private readonly items: T[] = [];
  private readonly index = new Map<T, number>();
  private readonly compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number, initial?: readonly T[]) {
    this.compare = compare;
    if (initial) {
      for (const item of initial) this.push(item);
    }
  }

  /** Number of entries currently in the heap. O(1). */
  get size(): number {
    return this.items.length;
  }

  /** Best (root) entry, or undefined when the heap is empty. O(1). */
  peek(): T | undefined {
    return this.items[0];
  }

  /** Whether the key is currently in the heap. O(1). */
  contains(item: T): boolean {
    return this.index.has(item);
  }

  /**
   * Insert an entry, or — if the key is already present — replace it in
   * place and restore the heap order. O(log n).
   */
  push(item: T): void {
    const existing = this.index.get(item);
    if (existing !== undefined) {
      this.items[existing] = item;
      const afterUp = this.siftUp(existing);
      this.siftDown(afterUp);
      return;
    }
    this.items.push(item);
    this.index.set(item, this.items.length - 1);
    this.siftUp(this.items.length - 1);
  }

  /** Remove and return the root. O(log n). Undefined when empty. */
  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    this.index.delete(top);
    const last = this.items.pop()!;
    this.index.delete(last);
    if (this.items.length > 0) {
      this.items[0] = last;
      this.index.set(last, 0);
      this.siftDown(0);
    }
    return top;
  }

  /**
   * Remove an arbitrary entry. O(1) lookup + O(log n) re-sift.
   * Returns false when the key is not in the heap.
   */
  remove(item: T): boolean {
    const at = this.index.get(item);
    if (at === undefined) return false;
    this.index.delete(item);
    const last = this.items.pop()!;
    this.index.delete(last);
    // When the removed entry was the last element there is nothing to
    // re-place; the array has simply shrunk.
    if (at < this.items.length) {
      this.items[at] = last;
      this.index.set(last, at);
      const afterUp = this.siftUp(at);
      this.siftDown(afterUp);
    }
    return true;
  }

  /** Remove all entries. O(n). */
  clear(): void {
    this.items.length = 0;
    this.index.clear();
  }

  /** Snapshot of the heap contents in heap order (root first). O(n). */
  toArray(): T[] {
    return [...this.items];
  }

  /**
   * Build a heap in O(n) from a flat array of entries (Floyd build).
   * Replaces any current contents.
   */
  heapify(entries: readonly T[]): void {
    this.clear();
    for (const entry of entries) {
      this.items.push(entry);
      this.index.set(entry, this.items.length - 1);
    }
    for (let i = (this.items.length >> 1) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  /** Sift the entry at `start` toward the root. Returns the final index. */
  private siftUp(start: number): number {
    let i = start;
    const { items, compare } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compare(items[i]!, items[p]!) < 0) {
        this.swap(i, p);
        i = p;
      } else {
        return i;
      }
    }
    return i;
  }

  /** Sift the entry at `start` toward the leaves. Returns the final index. */
  private siftDown(start: number): number {
    let i = start;
    const { items, compare } = this;
    const n = items.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < n && compare(items[l]!, items[best]!) < 0) best = l;
      if (r < n && compare(items[r]!, items[best]!) < 0) best = r;
      if (best === i) return i;
      this.swap(i, best);
      i = best;
    }
  }

  /** Swap two entries and keep the index map coherent. */
  private swap(a: number, b: number): void {
    const { items, index } = this;
    const ka = items[a]!;
    const kb = items[b]!;
    items[a] = kb;
    items[b] = ka;
    index.set(ka, b);
    index.set(kb, a);
  }
}
