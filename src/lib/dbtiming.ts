// Per-request D1 timing: how many round trips a request made and how long they took (Server-Timing header,
// slow-request log). Statements are wrapped, so `batch()` unwraps them before handing them to the real binding.

export interface DbTimer {
  db: D1Database;
  /** Round trips so far (each first/all/run/raw/batch/exec = 1). */
  count(): number;
  /** Summed wall time of those round trips in ms (parallel calls overlap, so this can exceed the request time). */
  ms(): number;
}

export function timedD1(real: D1Database): DbTimer {
  let n = 0;
  let total = 0;
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  async function time<T>(p: Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await p;
    } finally {
      n++;
      total += performance.now() - t0;
    }
  }
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...values: unknown[]) => wrap(s.bind(...values)),
      first: (col?: string) => time(col === undefined ? s.first() : s.first(col)),
      all: () => time(s.all()),
      run: () => time(s.run()),
      raw: (opts?: { columnNames?: boolean }) => time(s.raw(opts as { columnNames: true })),
    } as unknown as D1PreparedStatement;
    unwrap.set(w, s);
    return w;
  };
  const db = {
    prepare: (q: string) => wrap(real.prepare(q)),
    batch: (stmts: D1PreparedStatement[]) => time(real.batch(stmts.map((x) => unwrap.get(x) ?? x))),
    exec: (q: string) => time(real.exec(q)),
    dump: () => real.dump(),
    withSession: (c?: string) => real.withSession(c as D1SessionBookmark),
  } as unknown as D1Database;
  return { db, count: () => n, ms: () => total };
}
