// 120 consecutive mainnet headers, the node's eth_config and an eth_blobBaseFee snapshot, saved by
// scripts/fetch-fixtures.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type Config, audit, parseHeader } from "../src/audit.ts";
import { GAS_PER_BLOB, type Schedule, blobBaseFee, reservePriceBinds } from "../src/blob.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
const headers = fixture("headers.json").map(parseHeader);
const ethConfig = fixture("eth_config.json");
const snapshot = fixture("snapshot.json");
const schedule: Schedule = ethConfig.current.blobSchedule;
const cfg: Config = { schedule, activationTime: ethConfig.current.activationTime };

test("every real header's excess blob gas is what the rules give from its parent", () => {
  const report = audit(headers, cfg, { block: Number(snapshot.block), fee: BigInt(snapshot.fee) }, parseHeader(snapshot.header));
  assert.equal(report.audited, headers.length - 1);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.rpcFee.is, "own", "eth_blobBaseFee is the fee of the block it was read at");
});

test("these blocks exercise EIP-7918: the pre-Osaka rule gets them wrong", () => {
  const target = BigInt(schedule.target) * GAS_PER_BLOB;
  let wrong = 0;
  let bound = 0;
  for (let i = 1; i < headers.length; i++) {
    const p = headers[i - 1];
    const old = p.excessBlobGas + p.blobGasUsed < target ? 0n : p.excessBlobGas + p.blobGasUsed - target;
    if (old !== headers[i].excessBlobGas) wrong++;
    if (reservePriceBinds(p, schedule)) bound++;
  }
  assert.ok(bound > 0 && wrong > 0, `reserve price bound ${bound} times; the old rule missed ${wrong}`);
  assert.ok(wrong <= bound, "only blocks under the reserve price differ from the old rule");
});

test("the schedule is the one eth_config reports, and the fee is in the range the chain showed", () => {
  assert.deepEqual(Object.keys(schedule).sort(), ["baseFeeUpdateFraction", "max", "target"]);
  assert.ok(schedule.target < schedule.max);
  const fee = blobBaseFee(parseHeader(snapshot.header).excessBlobGas, schedule);
  assert.equal(fee, BigInt(snapshot.fee));
});
