import type { Task } from './types';

// Quick-sort partition for small arrays; returns the index of the pivot.
function partition(arr: Task[], lo: number, hi: number): number {
  const pivot = arr[hi];
  let i = lo;
  for (let j = lo; j < hi; j++) {
    if (compare(arr[j], pivot) <= 0) {
      swap(arr, i, j);
      i++;
    }
  }
  swap(arr, i, hi);
  return i;
}

function swap(arr: Task[], i: number, j: number) {
  const t = arr[i];
  arr[i] = arr[j];
  arr[j] = t;
}

function compare(a: Task, b: Task): number {
  // max-heap semantics: larger priority is "less" in ordering (comes first)
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  // tie-break by execution time (earliest first), then by creation time
  if (a.executeTime !== b.executeTime) {
    return a.executeTime - b.executeTime;
  }
  return a.createdAt - b.createdAt;
}

export class BinaryHeap {
  private data: Task[] = [];
  private hash: Map<string, number> = new Map<string, number>();

  constructor(compareFn?:(a: Task, b: Task) => number) {
    if (compareFn) {
      // use a custom comparator (rare)
      this._cmp = compareFn;
    }
  }

  private _cmp = compare;

  private _siftUp(idx: number): void {
    while (idx > 0) {
      const parent = this._parent(idx);
      if (this._cmp(this.data[idx], this.data[parent]) < 0) {
        swap(this.data, idx, parent);
        this.hash.set(this.data[idx].id, idx);
        this.hash.set(this.data[parent].id, parent);
        idx = parent;
      } else {
        break;
      }
    }
  }

  private _siftDown(idx: number): void {
    const size = this.data.length;
    while (true) {
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      let largest = idx;
      if (left < size && this._cmp(this.data[left], this.data[largest]) < 0) {
        largest = left;
      }
      if (right < size && this._cmp(this.data[right], this.data[largest]) < 0) {
        largest = right;
      }
      if (largest !== idx) {
        swap(this.data, idx, largest);
        this.hash.set(this.data[idx].id, idx);
        this.hash.set(this.data[largest].id, largest);
        idx = largest;
      } else {
        break;
      }
    }
  }

  // ---- public API -------------------------------------------------

  get length(): number {
    return this.data.length;
  }

  get size(): number {
    return this.data.length;
  }

  clear(): void {
    this.data = [];
    this.hash.clear();
  }

  push(task: Task): void {
    this.data.push(task);
    const idx = this.data.length - 1;
    this.hash.set(task.id, idx);
    this._siftUp(idx);
  }

  pop(): Task {
    const top = this.data[0];
    const size = this.data.length;
    if (size === 0) throw new Error('heap empty');
    const last = this.data.pop()!;
    this.hash.delete(last.id);
    if (size > 1) {
      this.data[0] = last;
      this.hash.set(last.id, 0);
      this._siftDown(0);
    }
    return top;
  }

  peek(): Task | null {
    return this.data.length === 0 ? null : this.data[0];
  }

  remove(taskId: string): boolean {
    const idx = this.hash.get(taskId);
    if (idx === undefined) return false;
    const size = this.data.length;
    const last = this.data[size - 1];
    // maintain positions map while mutating
    if (idx !== size - 1) {
      this.data[idx] = last;
      this.hash.set(last.id, idx);
    } else {
      this.data.pop();
      this.hash.delete(last.id);
    }
    this._siftDown(idx);
    return true;
  }

  contains(taskId: string): boolean {
    return this.hash.has(taskId);
  }

  heapify(tasks: Task[]): void {
    this.data = tasks.slice();
    this.hash.clear();
    for (let i = 0; i < this.data.length; i++) {
      this.hash.set(this.data[i].id, i);
    }
    for (let i = this._parent(this.data.length - 1); i >= 0; i--) {
      this._siftDown(i);
    }
  }

  private _parent(idx: number): number {
    return (idx - 1) >>> 1;
  }

  private _findIndexUnchecked(taskId: string): number {
    return this.hash.get(taskId)!;
  }

  toArray(): Task[] {
    return this.data.slice();
  }
}