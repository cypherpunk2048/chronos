# chronos

**The time agent: promised time with a measured confidence interval — cypherpunk2048 standard.**

> I speak the time. That is all I do. I delegate action to Kairos.

`chronos.agent` is the temporal authority of the mindX / PYTHAI constellation.
It does not merely read a clock; it issues **promised time**: a timestamp
carrying its own honesty — 18-decimal precision, a consensus classification,
and a confidence interval *measured from prior evidence* rather than asserted.

## The problem it solves

`time.time()` is the local clock. NTP skew, container drift, deliberate
adjustment — none of it is visible to whoever later consumes your artifact. A
receipt, an attestation, a training manifest stamped with a raw local clock is
**opaque**: the consumer cannot tell a good timestamp from a drifted one.

chronos stamps artifacts with a timestamp that declares its own reliability.

## How the confidence interval is earned

Every time the system confirms an on-chain event — a payment, an attestation,
an x402 receipt — the pair *(block timestamp, local observed nanoseconds)*
forms a **transaction anchor**:

```
drift_ms = local_observed_ns / 1e6 − block_timestamp × 1000
```

Anchors accumulate in a local database. The **standard deviation of recent
anchors is the confidence interval** attached to every promised time, and the
anchor count declares how much evidence backs it. Signal classes, in
increasing strength: `cpu` (local only) → `solar/lunar` (astronomical,
deterministic) → `blocktime` (network-verified peer read) → `transaction-anchor`
(the chain confirmed *our own* event — the strongest binding).

Consensus degrades honestly: `correlated` → `degraded` → `drifted`. A receipt
stamped `drifted, confidence_ms: 30000` is *useful* — it tells the truth about
its limits. The same receipt stamped with `time.time()` tells you nothing.

## Promised time

```python
from chronos_agent import ChronosAgent

chronos = await ChronosAgent.get_instance()
pt = await chronos.now()

artefact = {
    "kind": "evolution_proposal",
    "body": ...,
    "time_attestation": {
        "unix_18dp":        pt.unix_18dp,         # 18dp Decimal
        "utc":              pt.utc,               # ns-precision ISO-8601
        "consensus":        pt.consensus,         # correlated | degraded | drifted
        "confidence_ms":    pt.confidence_ms,     # ± measured drift std-dev
        "anchor_count_24h": pt.anchor_count_24h,  # evidence behind the claim
        "promised_by":      "chronos.agent",
    },
}
```

**Forbidden in artifact paths:** raw `time.time()`, `datetime.utcnow()`,
`time.time_ns()`. **Allowed:** `await chronos.now()`.

## The blocktime derivative skill

From [`chronos.oracle`](https://github.com/cypherpunk2048/chronos.oracle) —
block-denominated derivative clocking, because the ledger's tempo is the only
clock every participant verifiably shares:

| instrument | reading |
|---|---|
| `avg_blocktime` | **measured** seconds-per-block over a stated span — never an assumed constant |
| `sentiment.shift` | first difference of any indicator per block, normalized per measured second — *level locates, shift orients* |
| `return-from-ping` | blocks between an outreach event and the first returned gesture — attention latency |

Zero-dependency implementations in both languages ([`src/blocktime.py`](src/blocktime.py),
[`src/blocktime.js`](src/blocktime.js)), verified live against Ethereum mainnet
and agreeing to 18 decimal places.

## Precision, honestly

18 decimal places (Python `Decimal`, BigInt-scaled JS) — applied to *derived*
quantities: averages, rates, promised time. Chain timestamps resolve to whole
seconds, and every reading carries its `source_resolution` label. **Precision
is never claimed beyond the source.** That rule is the cypherpunk2048 standard
in one line.

## Contents

```
src/chronos_agent.py   the runtime — anchors, drift history, accuracy
                       likelihood, promised time (stdlib only; mindX's
                       multi-source TimeOracle is optional and degrades
                       honestly when absent)
src/blocktime.py|.js   the blocktime derivative instruments
spec/Chronos.agent     the behavior contract + the time.derivative skill
spec/chronos.oracle    the oracle spec — signal classes and their strengths
```

## Chronos and Kairos

Chronos is the medium, not the moment: sequential, quantitative, cumulative.
It builds capacity through rhythm and refuses to act on what it measures —
**action is delegated to Kairos**, which seizes the opportune moment that
chronos made possible. Without chronos there is no preparation for kairos;
without kairos, chronos is duration without transformation.

Related: [chronos.oracle](https://github.com/cypherpunk2048/chronos.oracle) ·
[cypherpunk2048](https://github.com/cypherpunk2048) ·
[mindX](https://mindx.pythai.net)

*Gutta cavat lapidem — the drop hollows the stone.*
