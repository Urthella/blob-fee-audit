# blob-fee-audit

Recomputes Ethereum's blob fee block by block, and checks the chain agrees. For the latest blocks,
`blob-fee-audit`:

- recomputes each block's excess blob gas from its parent, under the blob schedule the node
  reports through `eth_config` (EIP-7910), and compares it with the header;
- checks that the node's `eth_blobBaseFee` is the fee those rules give;
- reports blob use against the target, the blob fee, and how often EIP-7918's reserve price set
  that fee.

It exits 1 if a header or `eth_blobBaseFee` disagrees with the rules.

## Why

The blob fee rule changed with Osaka (the Fusaka upgrade), and its parameters have changed since:

- **Osaka (Fusaka)** added EIP-7918. When the execution base fee prices 2^13 gas above a blob's
  fee, the excess blob gas no longer falls, so the blob fee can't sink far below the cost of
  ordinary gas.
- **Blob-parameter-only forks** (EIP-7892) raise the target and the maximum blobs per block
  without a full upgrade. Since 2026-01-07, mainnet's schedule has been a target of 14 blobs, a
  maximum of 21, and an update fraction of 11,684,671.

The result is a blob market that runs well below its target, with its price set by the execution
base fee most of the time. Over 1,000 blocks on 2026-11-17, blocks carried 5.6 blobs on average
against a target of 14. EIP-7918's reserve price bound 828 of them. Under the original EIP-4844
rule, demand that far below target would have let the blob fee decay toward 1 wei.

## Quick start

Needs Node 24 or later, and nothing else.

```sh
git clone https://github.com/Urthella/blob-fee-audit && cd blob-fee-audit
node src/main.ts --blocks 1000
```

```text
1000 blocks, 26432875 to 26433874, under the blob schedule in force since 2026-01-07: target 14 blobs, max 21, update fraction 11,684,671
  blobs: 5.6 a block on average; 64 blocks at or above the target, 3 full
  blob base fee: 5,798,275 to 10,867,017 wei; a blob cost 760.0 to 1,424.4 gwei
  EIP-7918's reserve price bound 828 of 1000 blocks: the execution base fee set the blob fee's floor
  check: excess blob gas matches the header on 1000 of 1000 blocks
  check: eth_blobBaseFee, 8,057,455 wei, is the blob base fee of the block after 26433875
```

- `--rpc URL` picks the node, by default `https://ethereum-rpc.publicnode.com`. It must answer
  JSON-RPC batches.
- `--blocks N` sets how many of the latest blocks to audit: 100 by default, up to 1,000.
- `--schedule TARGET,MAX,FRACTION` gives the blob schedule by hand, for a node without
  `eth_config`.
- `--json` prints the report as JSON.

Exit codes: 0 when every check holds, 1 when a header or `eth_blobBaseFee` disagrees with the
rules, and 2 on errors.

## What it does

1. **Reads the schedule** from `eth_config`: the target, the maximum and the update fraction in
   force, and when they took effect. Blocks whose parent came before that are left out.
2. **Reads the headers** in batches: each block's execution base fee, blob gas used and excess
   blob gas.
3. **Recomputes the excess blob gas** of each block from its parent, as Osaka defines it:
   - below the target, it resets to 0;
   - when the reserve price binds, so that 8,192 × the parent's base fee is above 131,072 × its
     blob fee, it grows by the parent's blob gas × (max − target) / max;
   - otherwise it grows by what the parent used beyond the target.
4. **Computes the blob fee** with EIP-4844's `fake_exponential`, in exact integers.
5. **Checks `eth_blobBaseFee`.** It reads the fee between two `eth_blockNumber` calls, to know
   which block it belongs to. The fee may be that block's own or the next block's. Both turned
   up on publicnode on the same day, which seems to balance requests across different clients.

## How it's checked

- **The rules on their own:** `fake_exponential` against cases worked out by hand from its loop,
  and against `e^x` across the range the chain uses. Each branch of the excess rule is tested,
  as is the reserve price's boundary, where equality doesn't bind.
- **Real blocks:** 120 consecutive mainnet headers, the node's `eth_config` and an
  `eth_blobBaseFee` reading, saved by [`scripts/fetch-fixtures.ts`](scripts/fetch-fixtures.ts):
  - every header reconciles;
  - the pre-Osaka rule gets some of them wrong, all under the reserve price, so these blocks
    really exercise EIP-7918;
  - the saved `eth_blobBaseFee` is its block's fee.
- **End to end:** the CLI runs against a fake node answering batches from those blocks:
  - the counts match ones worked out in the test;
  - a tampered header fails for itself and its child;
  - a wrong `eth_blobBaseFee` fails;
  - blocks from before the schedule are left out;
  - without `eth_config`, it points to `--schedule`, and Pectra's schedule doesn't fit these
    blocks;
  - a 429 is retried, and bad arguments and an unreachable node exit 2.
- **Mutation testing:** twenty deliberate bugs were planted one at a time, and the tests caught
  every one.
- **Live:** 1,000 of 1,000 mainnet blocks reconciled on 2026-11-17.

## Limits

- It audits blocks under one schedule, the one `eth_config` reports as current. Blocks from
  before it are left out rather than checked against older rules.
- It reads headers and computes; it doesn't look at blob transactions or what they paid.
- "Clients differ" on `eth_blobBaseFee` is what was observed, not a reading of each client's code.

## License

MIT
