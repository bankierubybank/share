// Pure money math. All amounts are integer minor units (e.g. cents).

export interface Share {
  memberId: string;
  amount: number;
}

export interface Balance {
  memberId: string;
  paid: number;
  owed: number;
  net: number;
}

export interface Settlement {
  from: string;
  to: string;
  amount: number;
}

/** Split `amount` equally; remainder units go one each to the first members in the given order. */
export function splitEqual(amount: number, memberIds: string[]): Share[] {
  if (memberIds.length === 0) throw new Error("splitEqual: no members");
  const n = memberIds.length;
  const base = Math.floor(amount / n);
  const remainder = amount - base * n;
  return memberIds.map((memberId, i) => ({ memberId, amount: base + (i < remainder ? 1 : 0) }));
}

export interface BillForBalance {
  paidBy: string;
  amount: number;
  shares: Share[];
}

/** Per-member balances. net > 0 → member is owed money; net < 0 → member owes. */
export function computeBalances(memberIds: string[], bills: BillForBalance[]): Balance[] {
  const map = new Map<string, Balance>();
  for (const id of memberIds) map.set(id, { memberId: id, paid: 0, owed: 0, net: 0 });
  const get = (id: string) => {
    let b = map.get(id);
    if (!b) {
      b = { memberId: id, paid: 0, owed: 0, net: 0 };
      map.set(id, b);
    }
    return b;
  };
  for (const bill of bills) {
    get(bill.paidBy).paid += bill.amount;
    for (const s of bill.shares) get(s.memberId).owed += s.amount;
  }
  for (const b of map.values()) b.net = b.paid - b.owed;
  return [...map.values()];
}

/** Greedy minimal-ish settlement: largest debtor pays largest creditor. Deterministic. */
export function computeSettlements(balances: Balance[]): Settlement[] {
  const byMagnitude = (a: { id: string; amt: number }, b: { id: string; amt: number }) =>
    b.amt - a.amt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const creditors = balances.filter((b) => b.net > 0).map((b) => ({ id: b.memberId, amt: b.net }));
  const debtors = balances.filter((b) => b.net < 0).map((b) => ({ id: b.memberId, amt: -b.net }));
  const out: Settlement[] = [];
  while (creditors.length && debtors.length) {
    creditors.sort(byMagnitude);
    debtors.sort(byMagnitude);
    const c = creditors[0];
    const d = debtors[0];
    const amt = Math.min(c.amt, d.amt);
    out.push({ from: d.id, to: c.id, amount: amt });
    c.amt -= amt;
    d.amt -= amt;
    if (c.amt === 0) creditors.shift();
    if (d.amt === 0) debtors.shift();
  }
  return out;
}
