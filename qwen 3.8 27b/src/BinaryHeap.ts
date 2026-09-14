/**
 * BinaryHeap — a binary heap with O(1) arbitrary removal via a position map.
 *
 * Comparator contract: `compare(a, b) < 0` means `a` ranks HIGHER (closer to
 * the root). The heap is therefore a "min-heap" with respect to comparator
 * order, and the "top" is the maximum-priority element.
 *
 * Keyed by `element.id` (unique). Elements are stored by reference: key fields
 * (priority/executeTime/sequence for the scheduler) must not be mutated while
 * an element sits in the heap — the scheduler enforces this by removing
 * before any key mutation and re-inserting after.
 *
 * Complexity:
 *   push        O(log n)
 *   pop         O(log n)
 *   remove(id)  O(log n)
 *   peek        O(1)
 *   contains    O(1)
 *   heapify     O(n)  (Floyd build)
 *   space       O(n)  (items array + position map)
 */
export interface HeapElement {
  readonly id: string;
}

export type Comparator<T extends HeapElement> = (a: T, b: T) => number;

export class BinaryHeap<T extends HeapElement> {
  private readonly items: T[] = [];
  private readonly positions: Map<string, number> = new Map<string, number>();
  private readonly compare: Comparator<T>;

  constructor(compare: Comparator<T>) {
    this.compare = compare;
  }

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** The highest-ranking element, without removing it. */
  peek(): T | null {
    return this.items[0] ?? null;
  }

  contains(id: string): boolean {
    return this.positions.has(id);
  }

  indexOf(id: string): number {
    return this.positions.get(id) ?? -1;
  }

  /**
   * Insert. Throws on duplicate id (internal invariant violation — the
   * scheduler always removes before re-inserting).
   */
  push(element: T): void {
    if (this.positions.has(element.id)) {
      throw new Error(`BinaryHeap: duplicate element id '${element.id}'`);
    }
    this.items.push(element);
    this.positions.set(element.id, this.items.length - 1);
    this._siftUp(this.items.length - 1);
  }

  /** Remove and return the top. Throws if empty. */
  pop(): T {
    const n = this.items.length;
    if (n === 0) {
      throw new Error('BinaryHeap: pop from empty heap');
    }
    const top = this.items[0]!;
    const last = this.items.pop()!;
    this.positions.delete(top.id);
    if (n > 1) {
      // `last` was at the bottom; placed at the root it can only need to go down.
      this.items[0] = last;
      this.positions.set(last.id, 0);
      this._siftDown(0);
    }
    return top;
  }

  /**
   * Remove an arbitrary element by id in O(log n). Returns the element,
   * or null if absent.
   */
  remove(id: string): T | null {
    const idx = this.positions.get(id);
    if (idx === undefined) {
      return null;
    }
    const target = this.items[idx]!;
    const n = this.items.length;
    const last = this.items.pop()!;
    this.positions.delete(target.id);
    if (idx !== n - 1) {
      // `last` displaced into the hole: it may rank above its parent or below
      // its children — try up first, then down (at most one direction moves).
      this.items[idx] = last;
      this.positions.set(last.id, idx);
      const parent = (idx - 1) >> 1;
      if (parent >= 0 && this._beats(last, this.items[parent]!)) {
        this._siftUp(idx);
      } else {
        this._siftDown(idx);
      }
    }
    return target;
  }

  /**
   * Replace the whole heap in O(n) using Floyd's heapify.
   * Existing elements are discarded.
   */
  heapify(elements: readonly T[]): void {
    this.items.length = 0;
    this.positions.clear();
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]!;
      this.items[i] = el;
      this.positions.set(el.id, i);
    }
    for (let i = (this.items.length >> 1) - 1; i >= 0; i--) {
      this._siftDown(i);
    }
  }

  /** Shallow snapshot of heap storage (NOT in sorted order). */
  toArray(): T[] {
    return this.items.slice();
  }

  clear(): void {
    this.items.length = 0;
    this.positions.clear();
  }

  // ------------------------------------------------------------------ //
  //  internals
  // ------------------------------------------------------------------ //

  private _beats(a: T, b: T): boolean {
    return this.compare(a, b) < 0;
  }

  private _swap(i: number, j: number): void {
    const a = this.items[i]!;
    const b = this.items[j]!;
    this.items[i] = b;
    this.items[j] = a;
    this.positions.set(a.id, j);
    this.positions.set(b.id, i);
  }

  private _siftUp(idx: number): void {
    const n = this.items.length;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!this._beats(this.items[idx]!, this.items[parent]!)) {
        break;
      }
      this._swap(idx, parent);
      idx = parent;
    }
  }

  private _siftDown(idx: number): void {
    const n = this.items.length;
    for (;;) {
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      let best = idx;
      if (left < n && this._beats(this.items[left]!, this.items[best]!)) {
        best = left;
      }
      if (right < n && this._beats(this.items[right]!, this.items[best]!)) {
        best = right;
      }
      if (best === idx) {
        break;
      }
      this._swap(idx, best);
      idx = best;
    }
  }
}
