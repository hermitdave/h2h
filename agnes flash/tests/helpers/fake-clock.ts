/** Deterministic clock for time-sensitive tests. */
export class FakeClock {
  private _now: number;

  constructor(start = 1_000_000_000_000) {
    this._now = start;
  }

  now(): number {
    return this._now;
  }

  advance(ms: number): void {
    this._now += ms;
  }

  set(ms: number): void {
    this._now = ms;
  }

  get value(): number {
    return this._now;
  }
}
