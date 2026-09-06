"""chronos — price of a cryptocurrency from a liquidity pair, stamped by blocktime.

Zero dependencies (stdlib urllib). Python 3.10+. Extends src/blocktime.py:
the block timestamp is the stamp; the pair's own state AT THAT BLOCK is the price.

Doctrine (cypherpunk2048): a price is created by a liquidity pair and expressed
on the exchange that holds it. Aggregators are enrichment, never the source.
"In actual" means the pool's state read by eth_call at a stated block, so the
price and its time are one observation — never a quote from one moment and a
clock from another. A price without a block is a rumour.

Pools understood:
  Uniswap V2 (and every fork with getReserves): price = reserve1 / reserve0
  Uniswap V3 (slot0):                            price = (sqrtPriceX96 / 2^96)^2
Both corrected for token decimals, both derived by INTEGER floor division so the
JS twin (src/pairprice.js) agrees to the last of 18 decimals. Source resolution:
1 wei of each reserve (V2) / the Q64.96 fixed point (V3); the ratio is derived.

usage:
    python3 src/pairprice.py <pair> [--base SYMBOL|0xaddr] [--block N] [--rpc URL]
    python3 src/pairprice.py 0x57D2085Aa859a145cB107845AD03c0eAAFBD8a31 --base LUV
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from decimal import Decimal, getcontext

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from blocktime import avg_blocktime, latest_block  # noqa: E402  (same folder, zero-dep)

getcontext().prec = 80
SCALE = 10**18
Q96 = 1 << 96
DEFAULT_RPC = "https://ethereum-rpc.publicnode.com"
# Public nodes rate-limit and fail in bursts. A reading is retried across these in
# order; the stamp records which node actually answered. Override with --rpc.
FALLBACK_RPCS = ("https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://cloudflare-eth.com")

SEL = {
    "getReserves": "0x0902f1ac",
    "slot0": "0x3850c7bd",
    "token0": "0x0dfe1681",
    "token1": "0xd21220a7",
    "decimals": "0x313ce567",
    "symbol": "0x95d89b41",
}


def _rpc_once(rpc: str, method: str, params: list) -> dict:
    req = urllib.request.Request(
        rpc,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "chronos.pairprice/1.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(f"rpc {method}: {out['error']}")
    return out["result"]


def _try_rpcs(fn, rpc: str):
    """Call fn(rpc); on a transport or node error, try each fallback once. Returns (result, rpc_used)."""
    errs = []
    for r in (rpc, *[f for f in FALLBACK_RPCS if f != rpc]):
        try:
            return fn(r), r
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError, ValueError) as e:
            errs.append(f"{r}: {e}")
    raise RuntimeError("pairprice: every rpc failed — " + " | ".join(errs))


def _rpc(rpc: str, method: str, params: list) -> dict:
    return _try_rpcs(lambda r: _rpc_once(r, method, params), rpc)[0]


def _call(rpc: str, to: str, selector: str, block: int) -> str:
    return _rpc(rpc, "eth_call", [{"to": to, "data": selector}, hex(block)])[2:]


def _word(hexdata: str, i: int) -> int:
    return int(hexdata[64 * i : 64 * (i + 1)], 16)


def _addr(hexdata: str, i: int = 0) -> str:
    return "0x" + hexdata[64 * i + 24 : 64 * (i + 1)]


def _fmt18(scaled: int) -> str:
    neg = scaled < 0
    v = -scaled if neg else scaled
    return f"{'-' if neg else ''}{v // SCALE}.{v % SCALE:018d}"


def _decode_string(hexdata: str) -> str:
    """ABI string, with the bytes32 fallback some old tokens (MKR) use."""
    if not hexdata:
        return ""
    if len(hexdata) == 64:  # bytes32 symbol
        return bytes.fromhex(hexdata).rstrip(b"\x00").decode("utf-8", "replace")
    off = _word(hexdata, 0)
    ln = int(hexdata[off * 2 : off * 2 + 64], 16)
    start = off * 2 + 64
    return bytes.fromhex(hexdata[start : start + ln * 2]).decode("utf-8", "replace")


def token_meta(rpc: str, token: str, block: int) -> dict:
    dec = _word(_call(rpc, token, SEL["decimals"], block), 0)
    try:
        sym = _decode_string(_call(rpc, token, SEL["symbol"], block))
    except Exception:
        sym = token[:10]
    return {"address": token, "symbol": sym, "decimals": dec}


def pool_state(rpc: str, pair: str, block: int) -> dict:
    """Read the pair's state at `block`. Detects V2 (getReserves) or V3 (slot0)."""
    try:
        raw = _call(rpc, pair, SEL["getReserves"], block)
        if len(raw) >= 192:
            return {
                "kind": "uniswap-v2",
                "reserve0": _word(raw, 0),
                "reserve1": _word(raw, 1),
                "blockTimestampLast": _word(raw, 2),
            }
    except RuntimeError:
        pass
    raw = _call(rpc, pair, SEL["slot0"], block)
    if len(raw) < 128:
        raise RuntimeError(f"pairprice: {pair} answers neither getReserves() nor slot0()")
    tick = _word(raw, 1)
    if tick >= 1 << 255:
        tick -= 1 << 256
    return {"kind": "uniswap-v3", "sqrtPriceX96": _word(raw, 0), "tick": tick, "unlocked": bool(_word(raw, 6))}


def price_from_state(state: dict, dec0: int, dec1: int) -> tuple[int, int]:
    """(token1 per token0, token0 per token1), both scaled 1e18, integer floor."""
    if state["kind"] == "uniswap-v2":
        r0, r1 = state["reserve0"], state["reserve1"]
        if r0 == 0 or r1 == 0:
            raise ValueError("pairprice: empty reserve — no price exists")
        p10 = (r1 * 10**dec0 * SCALE) // (r0 * 10**dec1)
        p01 = (r0 * 10**dec1 * SCALE) // (r1 * 10**dec0)
        return p10, p01
    s = state["sqrtPriceX96"]
    if s == 0:
        raise ValueError("pairprice: uninitialized pool — no price exists")
    num = s * s * 10**dec0
    den = (Q96 * Q96) * 10**dec1
    return (num * SCALE) // den, (den * SCALE) // num


def price_at(pair: str, block: int | None = None, rpc: str = DEFAULT_RPC) -> dict:
    """The price both ways, from the pair, at one block — the blocktime stamp extended."""
    if block is None:
        head, rpc_used = _try_rpcs(latest_block, rpc)
    else:
        b, rpc_used = _try_rpcs(lambda r: _rpc_once(r, "eth_getBlockByNumber", [hex(block), False]), rpc)
        head = {"number": block, "timestamp": int(b["timestamp"], 16)}
    n = head["number"]
    t0 = token_meta(rpc, _addr(_call(rpc, pair, SEL["token0"], n)), n)
    t1 = token_meta(rpc, _addr(_call(rpc, pair, SEL["token1"], n)), n)
    state = pool_state(rpc, pair, n)
    p10, p01 = price_from_state(state, t0["decimals"], t1["decimals"])
    raw = {k: (str(v) if isinstance(v, int) and not isinstance(v, bool) else v) for k, v in state.items() if k != "kind"}
    out = {
        "instrument": "chronos.pairprice",
        "pair": pair,
        "kind": state["kind"],
        "token0": t0,
        "token1": t1,
        "raw": raw,
        f"{t1['symbol']}_per_{t0['symbol']}_18dp": _fmt18(p10),
        f"{t0['symbol']}_per_{t1['symbol']}_18dp": _fmt18(p01),
        "price_token1_per_token0_18dp": _fmt18(p10),
        "price_token0_per_token1_18dp": _fmt18(p01),
        "stamp": {
            "block": n,
            "timestamp": head["timestamp"],
            "rpc": rpc_used,
            "class": "pair-state@block",
        },
        "source_resolution": (
            "1 wei per reserve; ratio derived, 18dp, floor"
            if state["kind"] == "uniswap-v2"
            else "Q64.96 sqrtPriceX96; ratio derived, 18dp, floor"
        ),
    }
    if state["kind"] == "uniswap-v2":
        out["stamp"]["reserves_updated"] = state["blockTimestampLast"]
    return out


def quote(pair: str, base: str | None = None, block: int | None = None, rpc: str = DEFAULT_RPC) -> dict:
    """price_at(), plus 'the price of <base>' chosen by symbol or address."""
    p = price_at(pair, block, rpc)
    if base is not None:
        b = base.lower()
        if b in (p["token0"]["symbol"].lower(), p["token0"]["address"].lower()):
            p["base"], p["quote"], p["price_18dp"] = p["token0"]["symbol"], p["token1"]["symbol"], p["price_token1_per_token0_18dp"]
        elif b in (p["token1"]["symbol"].lower(), p["token1"]["address"].lower()):
            p["base"], p["quote"], p["price_18dp"] = p["token1"]["symbol"], p["token0"]["symbol"], p["price_token0_per_token1_18dp"]
        else:
            raise ValueError(f"pairprice: {base} is not a side of {pair}")
    return p


def price_shift(prev: dict, curr: dict, seconds_per_block: Decimal, key: str = "price_token1_per_token0_18dp") -> dict:
    """blocktime.sentiment_shift applied to a pair price: Δ per block, per MEASURED second."""
    d_blocks = curr["stamp"]["block"] - prev["stamp"]["block"]
    if d_blocks <= 0:
        raise ValueError("price.shift: non-advancing blocks")
    d = int(curr[key].replace(".", "")) - int(prev[key].replace(".", ""))
    per_block = d // d_blocks
    per_second = (per_block * SCALE) // int(seconds_per_block.scaleb(18).to_integral_value())
    return {
        "d_price_18dp": _fmt18(d),
        "d_blocks": d_blocks,
        "per_block_18dp": _fmt18(per_block),
        "per_second_18dp": _fmt18(per_second),
        "clock": "blocktime, normalized by measured average blocktime",
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pair")
    ap.add_argument("--base", help="symbol or address of the token to price")
    ap.add_argument("--block", type=int)
    ap.add_argument("--rpc", default=DEFAULT_RPC)
    ap.add_argument("--shift-span", type=int, default=0, help="also report Δprice over the last N blocks, per measured second")
    a = ap.parse_args()
    out = quote(a.pair, a.base, a.block, a.rpc)
    if a.shift_span > 0:
        prev = price_at(a.pair, out["stamp"]["block"] - a.shift_span, a.rpc)
        spb = _try_rpcs(lambda r: avg_blocktime(r, a.shift_span), a.rpc)[0]["seconds_per_block"]
        out["shift"] = {**price_shift(prev, out, spb), "seconds_per_block": str(spb)}
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
