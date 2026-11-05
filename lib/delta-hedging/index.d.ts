export type HedgePolicy = { enabled: boolean; threshold: number; tolerance: number; period: number;
  timing: "timer" | "scheduled"; hedgeBps: number; entry: "neutralize" | "policy"; exit: "unwind" | "hold" };
export type HedgeObservation = { time: number; price: number | null; delta: number | null;
  hedgeUnitDelta?: number; phase?: "entry" | "observe" | "exit"; positionPnl?: number };
export type HedgeFill = { time: number; price: number; amount: number; position: number; reason: string;
  cost: number; netDeltaBefore: number | null; netDeltaAfter: number | null };
export type HedgeResult = { grossPnl: number | null; netPnl: number | null; realized: number; unrealized: number | null;
  fill: HedgeFill | null; reason: string | null; netDeltaBefore: number | null; netDelta: number | null;
  position: number; cash: number; fees: number; turnover: number; tradeCount: number;
  gap: boolean; missingPrice: boolean; missingRisk: boolean };
export const DEFAULT_HEDGE_POLICY: Readonly<HedgePolicy>;
export type HedgeLedger = { position: number; cash: number; fees: number; averageEntry: number;
  realized: number; turnover: number; tradeCount: number };
export function hedgeDecision(state: { elapsed: number; netDelta: number | null; breachSince: number | null; previousElapsed?: number },
  policy: Pick<HedgePolicy, "threshold" | "tolerance" | "period" | "timing">): { reason: string | null; breachSince: number | null };
export function createHedgeLedger(): HedgeLedger;
export function executeHedge(ledger: HedgeLedger, fill: { time: number; price: number; target: number; reason: string;
  netDeltaBefore: number | null; hedgeUnitDelta?: number }, hedgeBps: number): HedgeFill | null;
export function markHedge(ledger: HedgeLedger, price: number | null): Pick<HedgeResult, "grossPnl" | "netPnl" | "realized" | "unrealized">;
export function normalizeHedgePolicy(policy?: Partial<HedgePolicy>): HedgePolicy;
export function createDeltaHedge(policy?: Partial<HedgePolicy>, options?: { observationSeconds?: number }): {
  policy: HedgePolicy; ledger: HedgeLedger;
  observe(sample: HedgeObservation): HedgeResult };
export function replayDeltaHedge(samples: HedgeObservation[], policy?: Partial<HedgePolicy>, options?: { observationSeconds?: number }): {
  rows: (HedgeObservation & HedgeResult)[]; trades: HedgeFill[]; policy: HedgePolicy };
