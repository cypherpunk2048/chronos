// chronos.oracle — blocktime instruments (cypherpunk2048 standard)
// Zero dependencies. Node ≥18 (global fetch) or any modern browser.
//
// The ledger's own tempo is the only clock every participant verifiably
// shares. These instruments therefore denominate time in BLOCKS, normalize
// by MEASURED average blocktime (never an assumed constant), and state
// their source resolution honestly: chain timestamps are integer seconds —
// 18-decimal precision below applies to DERIVED quantities (averages,
// rates), never to a claim of sub-second chain resolution.
//
// Instruments:
//   latestBlock(rpc)                       → { number, timestamp }
//   avgBlocktime(rpc, span)                → 18dp seconds-per-block (string)
//   blocksToSeconds(blocks, avg18)         → 18dp seconds (string)
//   sentimentShift(prev, curr, avg18)      → Δindicator per normalized block
//   returnFromPing(pingBlock, replyBlock, avg18) → attention latency
//
// All numeric outputs at 18dp are decimal STRINGS computed in BigInt
// (scale 1e18) — no float drift in the arithmetic path.

const SCALE = 10n ** 18n;

async function rpcCall(rpc, method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}

function fmt18(scaled) {
  const neg = scaled < 0n;
  const v = neg ? -scaled : scaled;
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(18, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function parse18(s) {
  const neg = s.startsWith("-");
  const [w, f = ""] = (neg ? s.slice(1) : s).split(".");
  const scaled = BigInt(w) * SCALE + BigInt(f.padEnd(18, "0").slice(0, 18));
  return neg ? -scaled : scaled;
}

export async function latestBlock(rpc) {
  const b = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]);
  return { number: parseInt(b.number, 16), timestamp: parseInt(b.timestamp, 16) };
}

/** Measured average blocktime over `span` blocks, 18dp seconds-per-block. */
export async function avgBlocktime(rpc, span = 100) {
  const head = await latestBlock(rpc);
  const past = await rpcCall(rpc, "eth_getBlockByNumber", [
    "0x" + (head.number - span).toString(16), false,
  ]);
  const dt = BigInt(head.timestamp - parseInt(past.timestamp, 16));
  return {
    seconds_per_block_18dp: fmt18((dt * SCALE) / BigInt(span)),
    span,
    head_block: head.number,
    source_resolution: "1s (chain timestamp granularity)",
  };
}

/** Convert a block count to 18dp seconds using a measured average. */
export function blocksToSeconds(blocks, avg18) {
  return fmt18(BigInt(blocks) * parse18(avg18));
}

/**
 * sentiment.shift — the first difference of an indicator over block time,
 * normalized by measured average blocktime so shifts are comparable across
 * network cadences. prev/curr: { value, block }.
 */
export function sentimentShift(prev, curr, avg18) {
  const dBlocks = curr.block - prev.block;
  if (dBlocks <= 0) throw new Error("sentiment.shift: non-advancing blocks");
  const dValue = curr.value - prev.value;
  const perBlock = (BigInt(Math.round(dValue * 1e9)) * SCALE) / (BigInt(dBlocks) * 10n ** 9n);
  // normalize: per SECOND of measured chain time = perBlock / avgBlocktime
  const perSecond = (perBlock * SCALE) / parse18(avg18);
  return {
    d_value: dValue,
    d_blocks: dBlocks,
    per_block_18dp: fmt18(perBlock),
    per_second_18dp: fmt18(perSecond),
    clock: "blocktime, normalized by measured average blocktime",
  };
}

/**
 * return-from-ping — attention latency: blocks between an outreach event
 * and the first returned gesture; seconds derived from measured average.
 */
export function returnFromPing(pingBlock, replyBlock, avg18) {
  if (replyBlock < pingBlock) throw new Error("return-from-ping: reply precedes ping");
  const blocks = replyBlock - pingBlock;
  return {
    blocks,
    seconds_18dp: blocksToSeconds(blocks, avg18),
    reading: "how quickly the community answers when addressed",
  };
}
