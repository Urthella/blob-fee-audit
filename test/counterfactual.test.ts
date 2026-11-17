// --counterfactual: the same blocks replayed under the rule before Osaka.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type Config, audit, parseHeader } from "../src/audit.ts";
import { GAS_PER_BLOB, type Header, type Schedule, blobBaseFee } from "../src/blob.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
const headers: Header[] = fixture("headers.json").map(parseHeader);
const ethConfig = fixture("eth_config.json");
const schedule: Schedule = ethConfig.current.blobSchedule;
const cfg: Config = { schedule, activationTime: ethConfig.current.activationTime };
const last = headers.at(-1)!;
const snapshot = { block: last.number, fee: blobBaseFee(last.excessBlobGas, schedule) };

test("the replay follows the real blobs from the first parent's real excess, with no reserve price", () => {
  const report = audit(headers, cfg, snapshot, last, { counterfactual: true });
  // Replayed here with the old rule written out in full.
  const target = BigInt(schedule.target) * GAS_PER_BLOB;
  let excess = headers[0].excessBlobGas;
  let lower = 0;
  for (let i = 1; i < headers.length; i++) {
    const used = headers[i - 1].blobGasUsed;
    excess = excess + used < target ? 0n : excess + used - target;
    if (blobBaseFee(excess, schedule) < blobBaseFee(headers[i].excessBlobGas, schedule)) lower++;
  }
  const c = report.counterfactual!;
  assert.equal(c.from, headers[0].number);
  assert.equal(c.start, String(blobBaseFee(headers[0].excessBlobGas, schedule)));
  assert.equal(c.end, String(blobBaseFee(excess, schedule)));
  assert.equal(c.actual, String(blobBaseFee(last.excessBlobGas, schedule)));
  assert.equal(c.lower, lower);
  assert.ok(BigInt(c.end) < BigInt(c.actual), "with blobs under the target, the old rule ends lower");
  assert.equal(audit(headers, cfg, snapshot, last).counterfactual, undefined, "only when asked");
});

test("the replay notes when the fee hits the 1-wei minimum", () => {
  // A quiet chain: no blobs, a small excess, and a base fee high enough that the reserve price binds.
  const chain: Header[] = Array.from({ length: 12 }, (_, i) => ({ number: 100 + i, timestamp: 2_000_000_000 + 12 * i, baseFeePerGas: 10n ** 11n, blobGasUsed: 0n, excessBlobGas: 200n * GAS_PER_BLOB }));
  const report = audit(chain, { schedule, activationTime: 0 }, { block: 111, fee: 0n }, chain.at(-1), { counterfactual: true });
  const c = report.counterfactual!;
  // Each empty block takes the target's 14 blobs off the excess: 200, 186, ... 74, 60. The fee is
  // e^(blobs × 131072 / 11684671) rounded down: 2 wei at 74 blobs, and 1 wei from 60, ten blocks in.
  assert.equal(c.start, "9");
  assert.equal(c.minimumAt, 110);
  assert.equal(c.end, "1");
  assert.equal(c.min, "1");
});

test("the replay starts from the first parent's excess, not its child's", () => {
  // Real excess 100, 300 and 500 blobs, no blobs used: the old rule takes 14 off per block from 100.
  const chain: Header[] = [100n, 300n, 500n].map((blobs, i) => ({ number: 200 + i, timestamp: 2_000_000_000 + 12 * i, baseFeePerGas: 1n, blobGasUsed: 0n, excessBlobGas: blobs * GAS_PER_BLOB }));
  const c = audit(chain, { schedule, activationTime: 0 }, { block: 202, fee: 0n }, chain.at(-1), { counterfactual: true }).counterfactual!;
  assert.equal(c.end, String(blobBaseFee(72n * GAS_PER_BLOB, schedule)), "100 − 14 − 14 = 72 blobs");
});
