"""chronos.oracle — blocktime instruments (cypherpunk2048 standard).

Zero dependencies (stdlib urllib + Decimal). Python 3.10+.

The ledger's own tempo is the only clock every participant verifiably shares.
These instruments denominate time in BLOCKS, normalize by MEASURED average
blocktime (never an assumed constant), and state source resolution honestly:
chain timestamps are integer seconds — the 18-decimal precision below applies
to DERIVED quantities (averages, rates), never to a claim of sub-second chain
resolution.
"""

from __future__ import annotations

import json
import urllib.request
from decimal import ROUND_FLOOR, Decimal, getcontext

getcontext().prec = 38  # 18dp with headroom, per the cypherpunk2048 standard

Q18 = Decimal(1).scaleb(-18)


def _q(x: Decimal) -> Decimal:
    """18dp, FLOOR — the same rounding as the JS twin's BigInt floor division, negatives included."""
    return x.quantize(Q18, rounding=ROUND_FLOOR)


def _rpc(rpc: str, method: str, params: list) -> dict:
    req = urllib.request.Request(
        rpc,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "chronos.oracle/1.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(f"rpc {method}: {out['error']}")
    return out["result"]


def latest_block(rpc: str) -> dict:
    b = _rpc(rpc, "eth_getBlockByNumber", ["latest", False])
    return {"number": int(b["number"], 16), "timestamp": int(b["timestamp"], 16)}


def avg_blocktime(rpc: str, span: int = 100) -> dict:
    """Measured seconds-per-block over `span` blocks, 18dp Decimal."""
    head = latest_block(rpc)
    past = _rpc(rpc, "eth_getBlockByNumber", [hex(head["number"] - span), False])
    dt = Decimal(head["timestamp"] - int(past["timestamp"], 16))
    return {
        "seconds_per_block": _q(dt / Decimal(span)),
        "span": span,
        "head_block": head["number"],
        "source_resolution": "1s (chain timestamp granularity)",
    }


def blocks_to_seconds(blocks: int, seconds_per_block: Decimal) -> Decimal:
    return _q(Decimal(blocks) * seconds_per_block)


def sentiment_shift(prev: dict, curr: dict, seconds_per_block: Decimal) -> dict:
    """First difference of an indicator over block time, average-normalized.

    prev/curr: {"value": float|Decimal, "block": int}.
    """
    d_blocks = curr["block"] - prev["block"]
    if d_blocks <= 0:
        raise ValueError("sentiment.shift: non-advancing blocks")
    d_value = Decimal(str(curr["value"])) - Decimal(str(prev["value"]))
    per_block = _q(d_value / Decimal(d_blocks))
    per_second = _q(per_block / seconds_per_block)
    return {
        "d_value": d_value,
        "d_blocks": d_blocks,
        "per_block": per_block,
        "per_second": per_second,
        "clock": "blocktime, normalized by measured average blocktime",
    }


def return_from_ping(ping_block: int, reply_block: int, seconds_per_block: Decimal) -> dict:
    """Attention latency: blocks between outreach and first returned gesture."""
    if reply_block < ping_block:
        raise ValueError("return-from-ping: reply precedes ping")
    blocks = reply_block - ping_block
    return {
        "blocks": blocks,
        "seconds": blocks_to_seconds(blocks, seconds_per_block),
        "reading": "how quickly the community answers when addressed",
    }
