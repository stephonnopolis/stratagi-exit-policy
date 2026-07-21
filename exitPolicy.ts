// ─────────────────────────────────────────────────────────────────────────────
// @stratagi/exit-policy — SHARED single-source exit-decision lib (v1.1.0)
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
  // Pip size source (Chat B's table-driven design): the symbol's pip_decimal_places
  // from the symbol row. pip size = 10 ** -pipDecimalPlaces. Both live and backtest
  // supply this per-symbol so no ticker can be missed when the symbol table changes.
  // Optional: if absent, ruleTrailing falls back to pipSizeFor(symbol) (the 8
  // production symbols, format-tolerant). Prefer supplying this.
  pipDecimalPlaces?: number | null;
  // A3 R-metric inputs — the SIGNAL's ORIGINAL entry/stop (from the position→
  // signal join), NOT the live position stop (which A1/A2 move). Populated by the
  // loop before the rule pass; null if the join found no signal (A3 skips → safe).
  originalEntry?: number | null;
  originalStop?: number | null;
  // Staged multi-TP inputs — the signal's TP ladder (TP1/TP2/TP3, from the signal
  // row: 1.5R/2.0R/3.0R). Live: from the position→signal join (same hop as
  // originalEntry/Stop). Backtest: from the signal row directly. Needed by
  // evaluateStagedTp to detect TP crossings + compute stop actions. Null → the
  // staged fn treats that TP level as absent (skips the stage — fail-safe).
  tp1?: number | null;
  tp2?: number | null;
  tp3?: number | null;
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
// Pip size = 10 ** -pip_decimal_places. TABLE-DRIVEN is the robust design (Chat B):
// the symbol table changes (forex went validating→production, BTC deprecated), so a
// hardcoded ticker list silently breaks. PRIMARY: pipSizeForDp(dp) with the symbol's
// pip_decimal_places passed in (from the symbol row) — no ticker can be missed.
// FALLBACK: pipSizeFor(symbol), format-tolerant, correct for the 8 production symbols
// as a safety net when dp isn't supplied.
//
// ⚠️ THREE DISTINCT SCALES — do NOT assume "forex = 4dp": the JPY pairs are 2dp.
//   XAU/USD      1dp → 0.1
//   USD-majors   4dp → 0.0001   (EUR/USD, GBP/USD, AUD/USD, NZD/USD)
//   JPY pairs    2dp → 0.01     (USD/JPY, GBP/JPY, EUR/JPY)
// Values equal 10^-pip_decimal_places from the signal worker's symbol table, so
// backtest pip math matches how signals actually resolved (pip-reconcile gate).

// PRIMARY — table-driven: pass the symbol's pip_decimal_places, get its pip size.
// Uses 1/10^dp (not Math.pow(10,-dp)) — the latter yields float artifacts like
// 0.00009999999999999999 for dp=4. Division by an integer power of 10 is exact for
// the dp values we use (0-5).
export function pipSizeForDp(pipDecimalPlaces: number | null | undefined): number | null {
  if (pipDecimalPlaces == null || !Number.isInteger(pipDecimalPlaces) || pipDecimalPlaces < 0) return null;
  return 1 / Math.pow(10, pipDecimalPlaces);
}

// FALLBACK — hardcoded lookup, FORMAT-TOLERANT (strips '/' + uppercases, so both
// 'EUR/USD' and 'EURUSD' resolve). Correct dp per the three scales. Safety net when
// pipDecimalPlaces isn't supplied; prefer pipSizeForDp.
const PIP_DP_BY_SYMBOL: Record<string, number> = {
  // production (8)
  XAUUSD: 1,                                    // gold 1dp → 0.1
  EURUSD: 4, GBPUSD: 4, AUDUSD: 4, NZDUSD: 4,   // USD majors 4dp → 0.0001
  USDJPY: 2, GBPJPY: 2, EURJPY: 2,              // JPY pairs 2dp → 0.01 (NOT 4dp — the trap)
  // deprecated (cheap to include; fail-safe if a stale ref appears)
  BTCUSD: 0,                                    // BTC 0dp → 1 (1 pip = $1)
  DIA: 2, TSLA: 2,                              // stocks 2dp
};

function normalizeSymbol(s: string): string {
  return s.replace(/\//g, '').toUpperCase();
}

// Price value of one pip for a symbol (format-tolerant), or null if unknown (→ A2 skips).
export function pipSizeFor(symbol: string): number | null {
  const dp = PIP_DP_BY_SYMBOL[normalizeSymbol(symbol)];
  return dp == null ? null : 1 / Math.pow(10, dp);
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
  // Table-driven pip size (Chat B): prefer the per-symbol pip_decimal_places
  // supplied on the position (from the symbol row); fall back to the format-
  // tolerant symbol lookup. Either way, unknown → null → skip (fail-safe).
  const pipSize = pipSizeForDp(pos.pipDecimalPlaces) ?? pipSizeFor(pos.symbol);
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

// ═════════════════════════════════════════════════════════════════════════════
// STAGED MULTI-TP — evaluateStagedTp (v1.1.0, Phase 2)
//
// A signal has TP1/TP2/TP3 (the 1.5R/2.0R/3.0R ladder). Staged management adds an
// active decision at each TP: as price reaches each level the position CLOSES
// (credited there) or CONTINUES toward the next TP with a STOP ACTION (protect/
// advance the stop). Gated tree: TP2 only if TP1 continued; TP3 only if TP2
// continued. TP3 is the ceiling — close or convert to a trailing stop (no TP4).
// One position, closes whole (no partials).
//
// PURE — no I/O. Reuses the trailing math + never-loosen (slWouldTighten) as the
// per-stage executors; does NOT rewrite exit math. Both backtest (now) and the
// live autotrader (deferred Phase 5, granularity gap) call this identically.
//
// Design: STAGED_TP_DESIGN.md (LOCKED 2026-07-21).
// ═════════════════════════════════════════════════════════════════════════════

// A stop action fires on CONTINUE at TP1/TP2 (protect/advance the stop).
export type StopAction =
  | { kind: 'breakeven' }                          // SL → entry (openPrice)
  | { kind: 'move_to_prior_tp' }                   // SL → the TP just hit
  | { kind: 'pip_offset'; behindTp: number }       // SL → N pips behind the TP just hit
  | { kind: 'trail'; distancePips: number };        // SL → trailing at N pips (from current price)

export interface StagedTpConfig {
  enabled: boolean;                                // off = today's passive behavior
  tp1: { onHit: 'close' | 'continue'; stopAction: StopAction | null };
  tp2: { onHit: 'close' | 'continue'; stopAction: StopAction | null }; // only if tp1 continued
  tp3: { onHit: 'close' | 'trail'; trailDistancePips: number | null }; // only if tp2 continued
}

// Monotonic stage — only advances (mirrors the resolver's monotonic tp_hit).
//   pre_tp1 → past_tp1 → past_tp2 → past_tp3_trailing ; or → closed at any level.
export type StagedTpStage =
  | 'pre_tp1'
  | 'past_tp1'
  | 'past_tp2'
  | 'past_tp3_trailing'
  | 'closed';

export interface StagedTpState {
  stage: StagedTpStage;
}

// Stage rank for the monotonic guard (only advance).
const STAGE_RANK: Record<StagedTpStage, number> = {
  pre_tp1: 0, past_tp1: 1, past_tp2: 2, past_tp3_trailing: 3, closed: 4,
};

// Has price reached a TP level? Direction-aware (BUY reads bid up to TP; SELL reads
// ask down to TP). Pessimistic bias belongs to the CALLER (backtest passes the bar
// extreme; live passes the tick) — this just compares the passed price to the level.
function reachedTp(type: ManagedPosition['type'], price: PriceSnapshot, tp: number): boolean {
  return type === 'POSITION_TYPE_BUY' ? price.bid >= tp : price.ask <= tp;
}

// Compute the SL a StopAction wants, given the TP just hit. Returns a target SL
// price (subject to never-loosen by the caller/this fn), or null if not computable.
function stopActionTarget(
  action: StopAction,
  pos: ManagedPosition,
  price: PriceSnapshot,
  tpJustHit: number,
  priorTp: number | null,   // the TP one level BELOW the one just hit (for move_to_prior_tp); null at TP1
): { to: number | null; note: string } {
  switch (action.kind) {
    case 'breakeven':
      return { to: pos.openPrice, note: `breakeven (SL→entry ${pos.openPrice})` };
    case 'move_to_prior_tp':
      // Move SL to the PRIOR TP level (per Example A: at TP2 → SL to TP1). At TP1
      // there is no prior TP → fall back to breakeven (SL→entry), the safe floor.
      if (priorTp == null) {
        return { to: pos.openPrice, note: `move_to_prior_tp at TP1 (no prior) → breakeven ${pos.openPrice}` };
      }
      return { to: priorTp, note: `move_to_prior_tp (SL→prior TP ${priorTp})` };
    case 'pip_offset': {
      const pipSize = pipSizeForDp(pos.pipDecimalPlaces) ?? pipSizeFor(pos.symbol);
      if (pipSize === null) return { to: null, note: `pip_offset: no pip size for ${pos.symbol} — skip` };
      // N pips BEHIND the TP just hit: BUY → below the TP; SELL → above the TP.
      const offset = action.behindTp * pipSize;
      const to = pos.type === 'POSITION_TYPE_BUY' ? tpJustHit - offset : tpJustHit + offset;
      return { to, note: `pip_offset(${action.behindTp} behind TP ${tpJustHit}) → SL ${to.toFixed(5)}` };
    }
    case 'trail': {
      const pipSize = pipSizeForDp(pos.pipDecimalPlaces) ?? pipSizeFor(pos.symbol);
      if (pipSize === null) return { to: null, note: `trail: no pip size for ${pos.symbol} — skip` };
      const dist = action.distancePips * pipSize;
      const to = pos.type === 'POSITION_TYPE_BUY' ? price.bid - dist : price.ask + dist;
      return { to, note: `trail(${action.distancePips}p) → SL ${to.toFixed(5)}` };
    }
  }
}

// Build a modify_sl Action from a StopAction target, enforcing never-loosen. If the
// target is null (uncomputable) or would loosen, returns a 'none' (no stop change)
// but the stage still advances (the CONTINUE decision stands; only the stop move is
// skipped). rule tag identifies the stage.
function stagedSlAction(
  target: { to: number | null; note: string },
  pos: ManagedPosition,
  rule: string,
): Action {
  if (target.to === null) {
    return { kind: 'none', reason: `staged ${target.note}`, rule };
  }
  if (!slWouldTighten(pos.type, pos.stopLoss, target.to)) {
    return { kind: 'none', reason: `staged stop ${target.note} would loosen (SL ${pos.stopLoss}) — hold (never-loosen)`, rule };
  }
  return { kind: 'modify_sl', to: target.to, reason: `staged ${target.note}`, rule };
}

// The staged decision. Given the position (with tp1/2/3), current price, the
// persisted stage, and the config → returns the Action to execute this evaluation
// AND the newStage to persist. PURE. The caller persists newStage BEFORE acting
// (crash-safe, like A4's fire-once) and applies the Action (modify_sl/close/none).
//
// CONTRACT:
// - enabled=false → { none, stage unchanged } (passive behavior).
// - Detects the FURTHEST TP reached that the stage hasn't passed yet, applies that
//   level's decision, advances stage by ONE level per call (monotonic). If price
//   has blown through multiple TPs in one gap, successive calls advance one each;
//   the caller loops until stage stabilizes if it wants same-tick multi-advance.
// - close → { close, newStage:'closed' }. continue → { the stopAction's modify_sl
//   (or none), newStage advanced }. TP3 trail → { modify_sl trailing, past_tp3_trailing }.
// - Past TP3 (past_tp3_trailing): keep trailing at tp3.trailDistancePips each call.
// - Never-loosen enforced on every stop move. Null TP level → that stage inert.
export function evaluateStagedTp(
  pos: ManagedPosition,
  price: PriceSnapshot,
  stageState: StagedTpState,
  config: StagedTpConfig,
): { action: Action; newStage: StagedTpStage } {
  const ruleBase = 'staged_tp';
  const stage = stageState.stage;

  if (!config.enabled) {
    return { action: { kind: 'none', reason: 'staged-TP disabled (passive)', rule: ruleBase }, newStage: stage };
  }
  if (stage === 'closed') {
    return { action: { kind: 'none', reason: 'already closed', rule: ruleBase }, newStage: 'closed' };
  }

  const rank = STAGE_RANK[stage];

  // ── Stage transitions, evaluated in order; advance ONE level per call. ──

  // pre_tp1 → TP1 reached?
  if (rank < STAGE_RANK['past_tp1'] && pos.tp1 != null && reachedTp(pos.type, price, pos.tp1)) {
    const rule = `${ruleBase}:tp1`;
    if (config.tp1.onHit === 'close') {
      return { action: { kind: 'close', reason: 'TP1 hit → close (staged)', rule }, newStage: 'closed' };
    }
    // continue + optional stop action
    const act = config.tp1.stopAction
      ? stagedSlAction(stopActionTarget(config.tp1.stopAction, pos, price, pos.tp1, null), pos, rule)
      : { kind: 'none' as const, reason: 'TP1 continue, no stop action', rule };
    return { action: act, newStage: 'past_tp1' };
  }

  // past_tp1 → TP2 reached? (only consulted because we're past TP1 = tp1 continued)
  if (rank < STAGE_RANK['past_tp2'] && rank >= STAGE_RANK['past_tp1'] &&
      pos.tp2 != null && reachedTp(pos.type, price, pos.tp2)) {
    const rule = `${ruleBase}:tp2`;
    if (config.tp2.onHit === 'close') {
      return { action: { kind: 'close', reason: 'TP2 hit → close (staged)', rule }, newStage: 'closed' };
    }
    const act = config.tp2.stopAction
      ? stagedSlAction(stopActionTarget(config.tp2.stopAction, pos, price, pos.tp2, pos.tp1 ?? null), pos, rule)
      : { kind: 'none' as const, reason: 'TP2 continue, no stop action', rule };
    return { action: act, newStage: 'past_tp2' };
  }

  // past_tp2 → TP3 reached? (ceiling: close or convert to trailing)
  if (rank < STAGE_RANK['past_tp3_trailing'] && rank >= STAGE_RANK['past_tp2'] &&
      pos.tp3 != null && reachedTp(pos.type, price, pos.tp3)) {
    const rule = `${ruleBase}:tp3`;
    if (config.tp3.onHit === 'close') {
      return { action: { kind: 'close', reason: 'TP3 hit → close (staged, ceiling)', rule }, newStage: 'closed' };
    }
    // trail beyond TP3 — requires a user-entered distance.
    if (config.tp3.trailDistancePips == null || config.tp3.trailDistancePips <= 0) {
      // No valid trail distance → advance to trailing stage but no stop move.
      return { action: { kind: 'none', reason: 'TP3 trail: no trail distance set — advance, no move', rule }, newStage: 'past_tp3_trailing' };
    }
    const act = stagedSlAction(
      stopActionTarget({ kind: 'trail', distancePips: config.tp3.trailDistancePips }, pos, price, pos.tp3, pos.tp2 ?? null),
      pos, rule,
    );
    return { action: act, newStage: 'past_tp3_trailing' };
  }

  // Already past TP3 → keep trailing at the ceiling distance each call.
  if (stage === 'past_tp3_trailing') {
    const rule = `${ruleBase}:tp3_trail`;
    if (config.tp3.onHit === 'trail' && config.tp3.trailDistancePips != null && config.tp3.trailDistancePips > 0) {
      const act = stagedSlAction(
        stopActionTarget({ kind: 'trail', distancePips: config.tp3.trailDistancePips }, pos, price, pos.tp3 ?? pos.openPrice, pos.tp2 ?? null),
        pos, rule,
      );
      return { action: act, newStage: 'past_tp3_trailing' };
    }
    return { action: { kind: 'none', reason: 'past TP3, no trailing configured', rule }, newStage: 'past_tp3_trailing' };
  }

  // No TP crossing this evaluation — hold, stage unchanged.
  return { action: { kind: 'none', reason: `no TP crossing (stage ${stage})`, rule: ruleBase }, newStage: stage };
}
