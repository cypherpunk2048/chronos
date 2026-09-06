// chronos — price of a cryptocurrency from a liquidity pair, stamped by blocktime
// Zero dependencies. Node ≥18 (global fetch) or any modern browser. Extends
// ./blocktime.js: the block timestamp is the stamp; the pair's own state AT
// THAT BLOCK is the price.
//
// Doctrine (cypherpunk2048): a price is created by a liquidity pair and
// expressed on the exchange that holds it. Aggregators are enrichment, never
// the source. "In actual" means the pool's state read by eth_call at a stated
// block, so the price and its time are one observation. A price without a
// block is a rumour.
//
// Pools understood:
//   Uniswap V2 (getReserves): price = reserve1 / reserve0
//   Uniswap V3 (slot0):       price = (sqrtPriceX96 / 2^96)^2
// Both corrected for token decimals, both derived by BigInt floor division so
// the Python twin (src/pairprice.py) agrees to the last of 18 decimals.
//
// Instruments:
//   tokenMeta(rpc, token, block)     → { address, symbol, decimals }
//   poolState(rpc, pair, block)      → V2 reserves or V3 slot0, BigInt
//   priceFromState(state, d0, d1)    → [token1 per token0, token0 per token1] scaled 1e18
//   priceAt(pair, block|null, rpc)   → the stamped reading, both ways
//   quote(pair, base, block, rpc)    → priceAt + "the price of <base>"
//   priceShift(prev, curr, avg18)    → Δprice per block / per measured second

import { latestBlock, avgBlocktime } from "./blocktime.js";

const SCALE = 10n ** 18n;
const Q96 = 1n << 96n;
// BigInt `/` truncates toward zero; Python `//` floors. Floor everywhere so the twins agree on negatives too.
const floorDiv = (a, b) => { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; };
export const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";
// Public nodes rate-limit and fail in bursts. A reading is retried across these in
// order; the stamp records which node actually answered. Override with --rpc.
export const FALLBACK_RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://cloudflare-eth.com"];
const SEL = {
  getReserves: "0x0902f1ac", slot0: "0x3850c7bd", token0: "0x0dfe1681",
  token1: "0xd21220a7", decimals: "0x313ce567", symbol: "0x95d89b41",
};

async function rpcOnce(rpc, method, params) {
  const res = await fetch(rpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}
/** fn(rpc); on a transport or node error, try each fallback once. Returns [result, rpcUsed]. */
async function tryRpcs(fn, rpc) {
  const errs = [];
  for (const r of [rpc, ...FALLBACK_RPCS.filter((f) => f !== rpc)]) {
    try { return [await fn(r), r]; } catch (e) { errs.push(`${r}: ${e.message || e}`); }
  }
  throw new Error("pairprice: every rpc failed — " + errs.join(" | "));
}
const rpcCall = async (rpc, method, params) => (await tryRpcs((r) => rpcOnce(r, method, params), rpc))[0];
const call = async (rpc, to, sel, block) =>
  (await rpcCall(rpc, "eth_call", [{ to, data: sel }, "0x" + block.toString(16)])).slice(2);
const word = (h, i) => BigInt("0x" + (h.slice(64 * i, 64 * (i + 1)) || "0"));
const addr = (h, i = 0) => "0x" + h.slice(64 * i + 24, 64 * (i + 1));

function fmt18(scaled) {
  const neg = scaled < 0n; const v = neg ? -scaled : scaled;
  return `${neg ? "-" : ""}${v / SCALE}.${(v % SCALE).toString().padStart(18, "0")}`;
}
function parse18(s) {
  const neg = s.startsWith("-"); const [w, f = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(w) * SCALE + BigInt(f.padEnd(18, "0").slice(0, 18)); return neg ? -v : v;
}
function decodeString(h) {
  if (!h) return "";
  const bytes = (hex) => new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16)));
  if (h.length === 64) return bytes(h).replace(/\0+$/, "");
  const off = Number(word(h, 0)) * 2;
  const len = Number(BigInt("0x" + h.slice(off, off + 64)));
  return bytes(h.slice(off + 64, off + 64 + len * 2));
}

export async function tokenMeta(rpc, token, block) {
  const decimals = Number(word(await call(rpc, token, SEL.decimals, block), 0));
  let symbol;
  try { symbol = decodeString(await call(rpc, token, SEL.symbol, block)); } catch { symbol = token.slice(0, 10); }
  return { address: token, symbol, decimals };
}

/** The pair's state at `block`. Detects V2 (getReserves) or V3 (slot0). */
export async function poolState(rpc, pair, block) {
  try {
    const raw = await call(rpc, pair, SEL.getReserves, block);
    if (raw.length >= 192) {
      return { kind: "uniswap-v2", reserve0: word(raw, 0), reserve1: word(raw, 1), blockTimestampLast: Number(word(raw, 2)) };
    }
  } catch { /* not V2 */ }
  const raw = await call(rpc, pair, SEL.slot0, block);
  if (raw.length < 128) throw new Error(`pairprice: ${pair} answers neither getReserves() nor slot0()`);
  let tick = word(raw, 1); if (tick >= 1n << 255n) tick -= 1n << 256n;
  return { kind: "uniswap-v3", sqrtPriceX96: word(raw, 0), tick: Number(tick), unlocked: word(raw, 6) !== 0n };
}

/** [token1 per token0, token0 per token1], both scaled 1e18, BigInt floor. */
export function priceFromState(state, dec0, dec1) {
  const d0 = 10n ** BigInt(dec0), d1 = 10n ** BigInt(dec1);
  if (state.kind === "uniswap-v2") {
    const { reserve0: r0, reserve1: r1 } = state;
    if (r0 === 0n || r1 === 0n) throw new Error("pairprice: empty reserve — no price exists");
    return [(r1 * d0 * SCALE) / (r0 * d1), (r0 * d1 * SCALE) / (r1 * d0)];
  }
  const s = state.sqrtPriceX96;
  if (s === 0n) throw new Error("pairprice: uninitialized pool — no price exists");
  const num = s * s * d0, den = Q96 * Q96 * d1;
  return [(num * SCALE) / den, (den * SCALE) / num];
}

/** The price both ways, from the pair, at one block — the blocktime stamp extended. */
export async function priceAt(pair, block = null, rpc = DEFAULT_RPC) {
  let head, rpcUsed;
  if (block === null) [head, rpcUsed] = await tryRpcs(latestBlock, rpc);
  else {
    let b; [b, rpcUsed] = await tryRpcs((r) => rpcOnce(r, "eth_getBlockByNumber", ["0x" + block.toString(16), false]), rpc);
    head = { number: block, timestamp: parseInt(b.timestamp, 16) };
  }
  const n = head.number;
  const t0 = await tokenMeta(rpc, addr(await call(rpc, pair, SEL.token0, n)), n);
  const t1 = await tokenMeta(rpc, addr(await call(rpc, pair, SEL.token1, n)), n);
  const state = await poolState(rpc, pair, n);
  const [p10, p01] = priceFromState(state, t0.decimals, t1.decimals);
  const raw = {};
  for (const [k, v] of Object.entries(state)) if (k !== "kind") raw[k] = typeof v === "bigint" || typeof v === "number" ? String(v) : v;
  const out = {
    instrument: "chronos.pairprice", pair, kind: state.kind, token0: t0, token1: t1, raw,
    [`${t1.symbol}_per_${t0.symbol}_18dp`]: fmt18(p10),
    [`${t0.symbol}_per_${t1.symbol}_18dp`]: fmt18(p01),
    price_token1_per_token0_18dp: fmt18(p10),
    price_token0_per_token1_18dp: fmt18(p01),
    stamp: { block: n, timestamp: head.timestamp, rpc: rpcUsed, class: "pair-state@block" },
    source_resolution: state.kind === "uniswap-v2"
      ? "1 wei per reserve; ratio derived, 18dp, floor"
      : "Q64.96 sqrtPriceX96; ratio derived, 18dp, floor",
  };
  if (state.kind === "uniswap-v2") out.stamp.reserves_updated = state.blockTimestampLast;
  return out;
}

/** priceAt(), plus "the price of <base>" chosen by symbol or address. */
export async function quote(pair, base = null, block = null, rpc = DEFAULT_RPC) {
  const p = await priceAt(pair, block, rpc);
  if (base !== null) {
    const b = base.toLowerCase();
    if (b === p.token0.symbol.toLowerCase() || b === p.token0.address.toLowerCase()) {
      Object.assign(p, { base: p.token0.symbol, quote: p.token1.symbol, price_18dp: p.price_token1_per_token0_18dp });
    } else if (b === p.token1.symbol.toLowerCase() || b === p.token1.address.toLowerCase()) {
      Object.assign(p, { base: p.token1.symbol, quote: p.token0.symbol, price_18dp: p.price_token0_per_token1_18dp });
    } else throw new Error(`pairprice: ${base} is not a side of ${pair}`);
  }
  return p;
}

/** blocktime.sentimentShift applied to a pair price: Δ per block, per MEASURED second. */
export function priceShift(prev, curr, avg18, key = "price_token1_per_token0_18dp") {
  const dBlocks = curr.stamp.block - prev.stamp.block;
  if (dBlocks <= 0) throw new Error("price.shift: non-advancing blocks");
  const d = parse18(curr[key]) - parse18(prev[key]);
  const perBlock = floorDiv(d, BigInt(dBlocks));
  const perSecond = floorDiv(perBlock * SCALE, parse18(avg18));
  return { d_price_18dp: fmt18(d), d_blocks: dBlocks, per_block_18dp: fmt18(perBlock), per_second_18dp: fmt18(perSecond),
    clock: "blocktime, normalized by measured average blocktime" };
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("pairprice.js")) {
  const [pair, ...rest] = process.argv.slice(2);
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  if (!pair) { console.error("usage: node src/pairprice.js <pair> [--base SYM|0x..] [--block N] [--rpc URL] [--shift-span N]"); process.exit(2); }
  const rpc = opt("--rpc") || DEFAULT_RPC, block = opt("--block") ? Number(opt("--block")) : null, span = Number(opt("--shift-span") || 0);
  quote(pair, opt("--base"), block, rpc).then(async (out) => {
    if (span > 0) {
      const prev = await priceAt(pair, out.stamp.block - span, rpc);
      const [{ seconds_per_block_18dp }] = await tryRpcs((r) => avgBlocktime(r, span), rpc);
      out.shift = { ...priceShift(prev, out, seconds_per_block_18dp), seconds_per_block: seconds_per_block_18dp };
    }
    console.log(JSON.stringify(out, null, 2));
  });
}
