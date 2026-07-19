// ─────────────────────────────────────────────────────────────────────────────
// @stratagi/exit-policy — SHARED single-source exit-decision lib (v1.0.0)
//
// This is the ONE source of exit-decision logic, imported by BOTH the live
// autotrader (posmanage loop) AND the signal-worker backtest, so a backtest with
// "trailing on" runs the IDENTICAL logic the live autotrader runs. Published as a
// pinned-tag repo (stratagi-exit-policy); both workers import a fixed version so
// live and backtest are provably the same code. DO NOT fork/vendor — import the
// pinned URL. Any change → bump the tag → both sides update deliberately.
//
// PURE: every rule is (position, price, config) → Action. No I/O, no imports, no
// side effects — unit-testable + dry-run-loggable, and safe to run in a backtest
// candle-executor with no broker at all. Execution (MetaApi modify/close) lives
// in the CALLER (the live loop / the backtest executor), never here.
// ─────────────────────────────────────────────────────────────────────────────
// Position-manager RULES — each a pure function (position, price, config) →
// Action. No I/O, no side effects — fully unit-testable + dry-run-loggable.
//
// The loop applies enabled rules in a FIXED SAFE ORDER per position:
//   move-SL-on-TP (A1) → trail (A2) → profit-close (A3) → time-close (A4)
// SL-moves compose (later rules only tighten, enforced by the loop core's
// never-loosen invariant); a CLOSE short-circuits remaining rules.
//
// Only A1 is implemented here for now; A2/A3/A4 are stubs to be filled one at a
// time (each dry-run → live). B1 is NOT a position rule (kill-switch subsystem).
// ─────────────────────────────────────────────────────────────────────────────

// A normalized position (mapped from the raw MetaApi position object by the loop).
export interface ManagedPosition {
  id: string;              // positionId
  symbol: string;          // broker symbol
  type: 'POSITION_TYPE_BUY' | 'POSITION_TYPE_SELL';
  openPrice: number;
  stopLoss: number | null; // may be absent
  takeProfit: number | null;
  volume: number;
  profit: number | null;   // unrealized, account currency (from the position read)
  // A3 R-metric inputs — the SIGNAL's ORIGINAL entry/stop (from the position→
  // signal join), NOT the live position stop (which A1/A2 move). Populated by the
  // loop before the rule pass; null if the join found no signal (A3 skips → safe).
  originalEntry?: number | null;
  originalStop?: number | null;
}

// Per-account exit-management config (the feature flags + params + modes).
export interface ExitConfig {
  // A1
  moveSlOnTp: boolean;
  moveSlOnTpMode: FeatureMode;
  // A2
  trailing: boolean;
  trailingMode: FeatureMode;
  trailingDistance: number | null;      // trail distance in PIPS
  trailingActivation: number | null;    // optional: only trail once +X pips profit (null = from entry)
  // A4
  dailyClose: boolean;
  dailyCloseMode: FeatureMode;
  dailyCloseTime: string | null;        // 'HH:MM' in dailyCloseTz
  dailyCloseTz: string;                 // IANA tz (default 'UTC')
  dailyCloseScope: 'all' | 'in_profit';
  dailyCloseDays: number[] | null;      // weekday ints 0=Sun..6=Sat; null = daily
  dailyCloseFireToday: boolean;         // TRANSIENT: set once per account per cycle by the loop (the fire-once decision). The per-position rule reads this; it does NOT recompute the trigger.
  // A3
  profitClose: boolean;
  profitCloseMode: FeatureMode;
  profitCloseThreshold: number | null;  // in profitCloseMetric units (default +3R applied in-code when null)
  profitCloseMetric: 'R' | 'usd';
  profitClosePortion: number;           // 0-1; 1.0 = full (v1)
}

export type FeatureMode = 'off' | 'dry_run' | 'live';

export type Action =
  | { kind: 'modify_sl'; to: number; reason: string; rule: string }
  | { kind: 'close'; reason: string; rule: string }
  | { kind: 'none'; reason: string; rule: string };

// Current price snapshot for the position's symbol.
export interface PriceSnapshot {
  bid: number;
  ask: number;
}

// ── A1 — MOVE SL ON TP HIT ───────────────────────────────────────────────────
// Intent: once price has reached the (first) take-profit distance, move the stop
// to BREAKEVEN (the open price) so the trade can't turn into a loss. This is the
// conservative first version: breakeven-on-TP1. (Later params could move SL to
// TP1 on TP2, etc. — kept simple for the first live rule.)
//
// Trigger: for a BUY, when the current price (bid) has reached takeProfit-level
// progress ≥ 1×TP distance... but we don't have the TP ladder here, only the
// position's takeProfit. So A1 v1: when price has moved from openPrice toward
// takeProfit by at least HALF the open→TP distance, move SL to breakeven.
// (Half is a safe, meaningful "in profit enough to protect" trigger; exact TP1
// crediting lives in the signal resolver, not the broker position.)
//
// The never-loosen invariant is enforced by the LOOP CORE, not here — A1 just
// proposes breakeven; the core rejects it if it would loosen the stop.
export function ruleMoveSlOnTp(
  pos: ManagedPosition,
  price: PriceSnapshot,
  cfg: ExitConfig,
): Action {
  const rule = 'A1_move_sl_on_tp';
  if (!cfg.moveSlOnTp || cfg.moveSlOnTpMode === 'off') {
    return { kind: 'none', reason: 'A1 disabled', rule };
  }
  if (pos.takeProfit === null) {
    return { kind: 'none', reason: 'no takeProfit on position — cannot gauge TP progress', rule };
  }

  const breakeven = pos.openPrice;

  if (pos.type === 'POSITION_TYPE_BUY') {
    const tpDistance = pos.takeProfit - pos.openPrice;
    if (tpDistance <= 0) return { kind: 'none', reason: 'non-positive TP distance (BUY)', rule };
    const progress = price.bid - pos.openPrice; // how far in profit
    if (progress >= tpDistance * 0.5) {
      return {
        kind: 'modify_sl',
        to: breakeven,
        reason: `BUY reached ${((progress / tpDistance) * 100).toFixed(0)}% of TP distance ` +
          `(bid ${price.bid} vs open ${pos.openPrice}, TP ${pos.takeProfit}) → move SL to breakeven ${breakeven}`,
        rule,
      };
    }
    return { kind: 'none', reason: `BUY only ${((progress / tpDistance) * 100).toFixed(0)}% to TP — not yet`, rule };
  }

  // SELL
  const tpDistance = pos.openPrice - pos.takeProfit;
  if (tpDistance <= 0) return { kind: 'none', reason: 'non-positive TP distance (SELL)', rule };
  const progress = pos.openPrice - price.ask; // how far in profit (price fell)
  if (progress >= tpDistance * 0.5) {
    return {
      kind: 'modify_sl',
      to: breakeven,
      reason: `SELL reached ${((progress / tpDistance) * 100).toFixed(0)}% of TP distance ` +
        `(ask ${price.ask} vs open ${pos.openPrice}, TP ${pos.takeProfit}) → move SL to breakeven ${breakeven}`,
      rule,
    };
  }
  return { kind: 'none', reason: `SELL only ${((progress / tpDistance) * 100).toFixed(0)}% to TP — not yet`, rule };
}

// ── A2 / A3 / A4 — stubs (built one at a time, each dry-run → live) ───────────
// ── PIP-SIZE MAP (A2 pips → price) ───────────────────────────────────────────
// The autotrader has no pip-size metadata (symbolMap is name-mapping only), so
// A2 needs the price value of one pip per BROKER symbol to convert
// trailing_distance_pips → a price distance. This mirrors the documented signal-
// worker convention (XAU 0.1, USD-forex 0.0001, JPY pairs 0.01, BTC 1) and the
// existing hardcoded symbolMap pattern.
//
// ⚠️ REAL-MONEY GATE: this hardcode must be reconciled against the signal
// worker's pip_decimal_places (the source of truth) before A2 trades any symbol
// for real. A drift here = a mis-sized trail. FAIL-SAFE: a symbol with no pip
// size returns null → A2 SKIPS it (no trail), never guesses.
const PIP_SIZE_BY_BROKER_SYMBOL: Record<string, number> = {
  XAUUSD: 0.1,     // gold: 1 pip = 0.1
  EURUSD: 0.0001,  // USD majors: 1 pip = 0.0001
  GBPUSD: 0.0001,
  AUDUSD: 0.0001,
  NZDUSD: 0.0001,
  USDJPY: 0.01,    // JPY pairs: 1 pip = 0.01
  GBPJPY: 0.01,
  EURJPY: 0.01,
  // BTCUSD intentionally absent (not mapped/traded) → fail-safe skip.
};

// Price value of one pip for a broker symbol, or null if unknown (→ A2 skips).
export function pipSizeFor(brokerSymbol: string): number | null {
  return PIP_SIZE_BY_BROKER_SYMBOL[brokerSymbol] ?? null;
}

// ── A2 — TRAILING STOP ───────────────────────────────────────────────────────
// As price moves favorably, SL trails at a fixed pip distance behind current
// price, only ever TIGHTENING (never-loosen enforced by the loop core too, but
// the rule also only proposes a tightening move). Optional activation: don't
// trail until the trade is +activation pips in profit.
//
//   BUY:  proposed SL = current_bid - trail_distance   (trails UP as bid rises)
//   SELL: proposed SL = current_ask + trail_distance   (trails DOWN as ask falls)
//
// FAIL-SAFE: unknown pip size → none (skip). The loop core's slWouldTighten is
// the final guard; this rule also self-checks it proposes a tighten before
// emitting, so a dry_run log never shows a loosening "would trail".
export function ruleTrailing(
  pos: ManagedPosition,
  price: PriceSnapshot,
  cfg: ExitConfig,
): Action {
  const rule = 'A2_trailing';
  if (!cfg.trailing || cfg.trailingMode === 'off') {
    return { kind: 'none', reason: 'A2 disabled', rule };
  }
  if (cfg.trailingDistance == null || cfg.trailingDistance <= 0) {
    return { kind: 'none', reason: 'no trail distance set', rule };
  }
  const pipSize = pipSizeFor(pos.symbol);
  if (pipSize === null) {
    return { kind: 'none', reason: `no pip size for ${pos.symbol} — skip (fail-safe)`, rule };
  }
  const trailPrice = cfg.trailingDistance * pipSize;
  const activationPrice = cfg.trailingActivation != null ? cfg.trailingActivation * pipSize : null;

  if (pos.type === 'POSITION_TYPE_BUY') {
    // Profit progress in price terms (bid vs open).
    const profitPrice = price.bid - pos.openPrice;
    if (activationPrice !== null && profitPrice < activationPrice) {
      return { kind: 'none', reason: `BUY not yet +${cfg.trailingActivation} pips (activation) — no trail`, rule };
    }
    const proposedSl = price.bid - trailPrice;
    // Only propose if it TIGHTENS (moves SL up vs current). null SL → allowed.
    if (pos.stopLoss !== null && proposedSl <= pos.stopLoss) {
      return { kind: 'none', reason: `BUY trail ${proposedSl.toFixed(5)} not tighter than current SL ${pos.stopLoss} — hold`, rule };
    }
    return {
      kind: 'modify_sl',
      to: proposedSl,
      reason: `BUY trail: SL ${pos.stopLoss ?? 'none'} → ${proposedSl.toFixed(5)} ` +
        `(${cfg.trailingDistance} pips behind bid ${price.bid})`,
      rule,
    };
  }

  // SELL
  const profitPrice = pos.openPrice - price.ask;
  if (activationPrice !== null && profitPrice < activationPrice) {
    return { kind: 'none', reason: `SELL not yet +${cfg.trailingActivation} pips (activation) — no trail`, rule };
  }
  const proposedSl = price.ask + trailPrice;
  // Only propose if it TIGHTENS (moves SL down vs current). null SL → allowed.
  if (pos.stopLoss !== null && proposedSl >= pos.stopLoss) {
    return { kind: 'none', reason: `SELL trail ${proposedSl.toFixed(5)} not tighter than current SL ${pos.stopLoss} — hold`, rule };
  }
  return {
    kind: 'modify_sl',
    to: proposedSl,
    reason: `SELL trail: SL ${pos.stopLoss ?? 'none'} → ${proposedSl.toFixed(5)} ` +
      `(${cfg.trailingDistance} pips behind ask ${price.ask})`,
    rule,
  };
}
// ── A3 — AGGRESSIVE CLOSER (profit-close) ────────────────────────────────────
// Close a position once its profit reaches a threshold. metric 'R' measures the
// R-multiple against the SIGNAL'S ORIGINAL stop (position.originalEntry/Stop from
// the loop's signal join) — NOT the live position stop, which A1/A2 move (that
// would give a wrong, inflated R). metric 'usd' uses account-currency profit
// (not normalized). Full close (portion reserved for v2).
//
// ⚠️ CAPS WINNERS — footgun. Default threshold deliberately HIGH (+3R) so a
// careless enable only caps the biggest winners.
//
// FAIL-SAFE: metric 'R' with no original stop (join miss / null) → SKIP (no
// close), never guess. Only closes on a confident, above-threshold reading.
const A3_DEFAULT_R = 3; // deliberately-high conservative default

export function ruleProfitClose(pos: ManagedPosition, price: PriceSnapshot, cfg: ExitConfig): Action {
  const rule = 'A3_profit_close';
  if (!cfg.profitClose || cfg.profitCloseMode === 'off') {
    return { kind: 'none', reason: 'A3 disabled', rule };
  }

  if (cfg.profitCloseMetric === 'usd') {
    // Account-currency profit (not normalized across lot sizes).
    const threshold = cfg.profitCloseThreshold; // no default for usd — require explicit
    if (threshold == null || threshold <= 0) {
      return { kind: 'none', reason: 'A3 usd: no positive threshold set', rule };
    }
    if (pos.profit == null) {
      return { kind: 'none', reason: 'A3 usd: null P&L — skip (fail-safe)', rule };
    }
    if (pos.profit >= threshold - 1e-9) {
      return { kind: 'close', reason: `A3 would close: position ${pos.id} at +$${pos.profit} (threshold +$${threshold})`, rule };
    }
    return { kind: 'none', reason: `A3 usd: +$${pos.profit} below threshold +$${threshold}`, rule };
  }

  // metric 'R' — R-multiple vs the ORIGINAL signal stop.
  const threshold = cfg.profitCloseThreshold ?? A3_DEFAULT_R; // +3R default
  if (pos.originalEntry == null || pos.originalStop == null) {
    return { kind: 'none', reason: `A3 R: no original signal stop for position ${pos.id} — skip (fail-safe)`, rule };
  }
  const risk = Math.abs(pos.originalEntry - pos.originalStop);
  if (!(risk > 0)) {
    return { kind: 'none', reason: `A3 R: zero/invalid original risk for position ${pos.id} — skip`, rule };
  }
  // Current favorable move, direction-aware, using the same price the loop read.
  const current = pos.type === 'POSITION_TYPE_BUY' ? price.bid : price.ask;
  const move = pos.type === 'POSITION_TYPE_BUY'
    ? current - pos.originalEntry   // BUY profits as price rises above entry
    : pos.originalEntry - current;  // SELL profits as price falls below entry
  const rMultiple = move / risk;
  // Epsilon tolerance: float division (e.g. 0.0150/0.0050) can land at 2.9999…,
  // so a position exactly AT threshold would miss a strict >=. Tolerate a hair.
  if (rMultiple >= threshold - 1e-9) {
    return {
      kind: 'close',
      reason: `A3 would close: position ${pos.id} at +${rMultiple.toFixed(2)}R (threshold +${threshold}R, orig entry ${pos.originalEntry}/stop ${pos.originalStop})`,
      rule,
    };
  }
  return { kind: 'none', reason: `A3 R: +${rMultiple.toFixed(2)}R below threshold +${threshold}R`, rule };
}
// ── A4 — DAILY CLOSE (time trigger) ──────────────────────────────────────────
// A4 is an ACCOUNT-LEVEL time trigger, unlike the per-position price rules. The
// loop decides ONCE per account per cycle whether A4 fires today (via
// dailyCloseShouldFire), stamps the fire-once date, and sets cfg.dailyCloseFireToday.
// The per-position ruleDailyClose then just applies the in-profit filter.

// tz-aware wall-clock parts for an instant, using Intl (DST-correct in Deno).
export function tzParts(now: Date, tz: string): { date: string; weekday: number; minutes: number } {
  // en-CA gives YYYY-MM-DD; weekday short → map to 0..6; hour/minute 24h.
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = dtf.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some environments render midnight as 24
  const minutes = hour * 60 + parseInt(get('minute'), 10);
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wdMap[get('weekday')] ?? 0;
  return { date, weekday, minutes };
}

function parseHHMM(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// The ACCOUNT-LEVEL fire-once decision. Returns whether A4 should fire this cycle
// and the tz-local date to stamp. Fires iff: feature configured + today is a
// scheduled weekday (in tz) + the trigger time has passed (in tz) + it hasn't
// already run today (lastRanDate != today). Catch-up-safe (fires late if a cycle
// was missed) and miss-safe (any cycle after the trigger time fires it).
export function dailyCloseShouldFire(
  cfg: ExitConfig,
  lastRanDate: string | null,
  now: Date,
): { fire: boolean; todayInTz: string; reason: string } {
  const triggerMin = parseHHMM(cfg.dailyCloseTime);
  if (triggerMin === null) return { fire: false, todayInTz: '', reason: 'no/invalid trigger time' };

  let parts;
  try {
    parts = tzParts(now, cfg.dailyCloseTz);
  } catch {
    // Bad tz (shouldn't happen — validated on save) → fail-safe, don't fire.
    return { fire: false, todayInTz: '', reason: `bad tz ${cfg.dailyCloseTz}` };
  }
  const { date: todayInTz, weekday, minutes: nowMin } = parts;

  // Scheduled weekday? null days = daily.
  if (cfg.dailyCloseDays !== null && !cfg.dailyCloseDays.includes(weekday)) {
    return { fire: false, todayInTz, reason: `weekday ${weekday} not scheduled` };
  }
  // Already ran today (fire-once)?
  if (lastRanDate === todayInTz) {
    return { fire: false, todayInTz, reason: 'already ran today' };
  }
  // Has the trigger time passed today (in tz)?
  if (nowMin < triggerMin) {
    return { fire: false, todayInTz, reason: `before trigger (${nowMin} < ${triggerMin})` };
  }
  return { fire: true, todayInTz, reason: `trigger passed (${nowMin} >= ${triggerMin}), not yet run today` };
}

// Per-position A4 rule. Assumes the loop already decided the account fires today
// (cfg.dailyCloseFireToday). Applies the in-profit filter. In 'in_profit' scope,
// closes only profit > 0 (breakeven 0 and null profit → LEAVE open, fail-safe).
export function ruleDailyClose(pos: ManagedPosition, _price: PriceSnapshot, cfg: ExitConfig): Action {
  const rule = 'A4_daily_close';
  if (!cfg.dailyClose || cfg.dailyCloseMode === 'off') {
    return { kind: 'none', reason: 'A4 disabled', rule };
  }
  if (!cfg.dailyCloseFireToday) {
    return { kind: 'none', reason: 'A4 not triggered this cycle', rule };
  }
  if (cfg.dailyCloseScope === 'in_profit') {
    if (pos.profit === null) {
      return { kind: 'none', reason: 'A4 in_profit: null P&L — leave open (fail-safe)', rule };
    }
    if (pos.profit <= 0) {
      return { kind: 'none', reason: `A4 would leave: position ${pos.id} (P&L ${pos.profit}) [not in profit]`, rule };
    }
    return { kind: 'close', reason: `A4 would close: position ${pos.id} (P&L +${pos.profit}) [in-profit ✓]`, rule };
  }
  // scope 'all'
  return { kind: 'close', reason: `A4 would close: position ${pos.id} (P&L ${pos.profit ?? 'n/a'}) [scope=all]`, rule };
}

// The never-loosen invariant (loop core uses this — exported for testability).
// A proposed SL is only allowed if it TIGHTENS (or holds) the stop:
//   BUY:  new SL must be >= current SL (higher = more protective)
//   SELL: new SL must be <= current SL (lower  = more protective)
// A position with no current SL: any SL is allowed (nothing to loosen).
export function slWouldTighten(
  type: ManagedPosition['type'],
  currentSl: number | null,
  proposedSl: number,
): boolean {
  if (currentSl === null) return true;
  if (type === 'POSITION_TYPE_BUY') return proposedSl >= currentSl;
  return proposedSl <= currentSl;
}
