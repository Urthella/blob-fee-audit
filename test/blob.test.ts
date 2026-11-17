import assert from "node:assert/strict";
import { test } from "node:test";

import { GAS_PER_BLOB, type Header, type Schedule, blobBaseFee, fakeExponential, nextExcessBlobGas, reservePriceBinds } from "../src/blob.ts";

const BPO2: Schedule = { target: 14, max: 21, baseFeeUpdateFraction: 11_684_671 };
const header = (excessBlobs: number, usedBlobs: number, baseFee: bigint, extra = 0n): Header => ({
  number: 1,
  timestamp: 1,
  baseFeePerGas: baseFee,
  blobGasUsed: BigInt(usedBlobs) * GAS_PER_BLOB,
  excessBlobGas: BigInt(excessBlobs) * GAS_PER_BLOB + extra,
});

test("fake_exponential matches cases worked out by hand from EIP-4844's loop", () => {
  // (1, 2, 1): 1 + 2 + 2 + 1 = 6. (1, 4, 2): (2 + 4 + 4 + 2 + 1) / 2 = 6.
  assert.equal(fakeExponential(1n, 2n, 1n), 6n);
  assert.equal(fakeExponential(1n, 4n, 2n), 6n);
  assert.equal(fakeExponential(1n, 0n, 1n), 1n, "e^0");
  assert.equal(fakeExponential(38493n, 0n, 1000n), 38493n, "the factor times e^0");
  assert.equal(fakeExponential(0n, 1234n, 2345n), 0n, "a zero factor");
});

test("fake_exponential stays close to e^x across the range the chain uses", () => {
  for (const x of [0.5, 1, 5, 10, 15.8, 20, 25]) {
    const fraction = 11_684_671n;
    const approx = Number(fakeExponential(1_000_000n, BigInt(Math.round(x * Number(fraction))), fraction)) / 1_000_000;
    assert.ok(Math.abs(approx / Math.exp(x) - 1) < 1e-4, `e^${x}: ${approx} against ${Math.exp(x)}`);
  }
});

test("the blob base fee is 1 wei with no excess, and grows with it", () => {
  assert.equal(blobBaseFee(0n, BPO2), 1n);
  assert.ok(blobBaseFee(100_000_000n, BPO2) > blobBaseFee(90_000_000n, BPO2));
});

test("below the target, the excess resets to 0", () => {
  assert.equal(nextExcessBlobGas(header(0, 13, 1n), BPO2), 0n);
  assert.equal(nextExcessBlobGas(header(5, 8, 10n ** 12n), BPO2), 0n, "excess plus use under the target resets even if the reserve price would bind");
});

test("when the reserve price doesn't bind, the excess grows by what was used beyond the target", () => {
  const parent = header(1_000, 16, 1n);
  assert.ok(!reservePriceBinds(parent, BPO2));
  assert.equal(nextExcessBlobGas(parent, BPO2), (1_000n + 2n) * GAS_PER_BLOB);
  assert.equal(nextExcessBlobGas(header(1_000, 6, 1n), BPO2), (1_000n - 8n) * GAS_PER_BLOB, "and shrinks when use is under it");
});

test("when the reserve price binds, the excess grows by use times (max - target) / max", () => {
  const parent = header(1_000, 6, 10n ** 12n);
  assert.ok(reservePriceBinds(parent, BPO2), "8192 gas at 1,000 gwei outprices a blob at the tiny blob fee");
  assert.equal(nextExcessBlobGas(parent, BPO2), 1_000n * GAS_PER_BLOB + (6n * GAS_PER_BLOB * 7n) / 21n);
  assert.equal(nextExcessBlobGas(header(1_000, 0, 10n ** 12n), BPO2), 1_000n * GAS_PER_BLOB, "an empty block leaves the excess where it was");
});

test("the reserve price binds exactly when 8192 × base fee exceeds 131072 × blob fee", () => {
  const excess = 1_000n * GAS_PER_BLOB;
  const blobFee = blobBaseFee(excess, BPO2);
  const atParity = (blobFee * GAS_PER_BLOB) / 8_192n; // the base fee at which both prices are equal
  const parent = (baseFee: bigint): Header => ({ ...header(0, 0, baseFee), excessBlobGas: excess });
  assert.ok(!reservePriceBinds(parent(atParity), BPO2), "equal isn't above");
  assert.ok(reservePriceBinds(parent(atParity + 1n), BPO2));
});

test("before Osaka, the excess only follows use against the target, with no reserve price", async () => {
  const { nextExcessBlobGasBeforeOsaka } = await import("../src/blob.ts");
  const rich = header(1_000, 6, 10n ** 12n); // the reserve price would bind after Osaka
  assert.equal(nextExcessBlobGasBeforeOsaka(rich, BPO2), (1_000n - 8n) * GAS_PER_BLOB);
  assert.equal(nextExcessBlobGasBeforeOsaka(header(3, 6, 1n), BPO2), 0n, "below the target it resets");
});
