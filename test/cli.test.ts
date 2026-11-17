// Runs the real CLI against a fake JSON-RPC node that answers batches from the saved mainnet data,
// and can be told to misbehave.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
const headers: Record<string, string>[] = fixture("headers.json");
const ethConfig = fixture("eth_config.json");
const snapshot = fixture("snapshot.json");
const latest = headers.at(-1)!.number;
const byNumber = new Map([...headers, snapshot.header].map((h: Record<string, string>) => [Number(h.number), h]));

let noConfig = false;
let tamperedBlock: number | undefined;
let wrongFee = false;
let rateLimits = 0;
let activationAfter: number | undefined;

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (rateLimits > 0) {
    rateLimits--;
    return void response.writeHead(429, { "retry-after": "1" }).end("slow down");
  }
  const calls = JSON.parse(body) as { id: number; method: string; params: unknown[] }[];
  const answer = ({ id, method, params }: (typeof calls)[number]) => {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    switch (method) {
      case "eth_config": {
        if (noConfig) return error(-32601, "the method eth_config does not exist/is not available");
        const timestamp = activationAfter === undefined ? ethConfig.current.activationTime : Number(byNumber.get(activationAfter)!.timestamp);
        return ok({ ...ethConfig, current: { ...ethConfig.current, activationTime: timestamp } });
      }
      case "eth_blockNumber":
        return ok(latest);
      case "eth_blobBaseFee":
        return ok(wrongFee ? `0x${(BigInt(snapshot.fee) + 1n).toString(16)}` : snapshot.fee);
      case "eth_getBlockByNumber": {
        const n = Number(params[0]);
        const h = byNumber.get(n);
        if (!h) return ok(null);
        return ok(n === tamperedBlock ? { ...h, excessBlobGas: `0x${(BigInt(h.excessBlobGas) + 1n).toString(16)}` } : h);
      }
    }
    return error(-32601, "method not found");
  };
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(calls.map(answer)));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
server.unref();
const RPC = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// The fake node's eth_blockNumber is the last saved header, so the fee snapshot is taken there.
const lastHeader = headers.at(-1)!;
snapshot.block = lastHeader.number;
snapshot.header = lastHeader;
const { blobBaseFee } = await import("../src/blob.ts");
snapshot.fee = `0x${blobBaseFee(BigInt(lastHeader.excessBlobGas), ethConfig.current.blobSchedule).toString(16)}`;

function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, "--rpc", RPC, ...args], (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, out: stdout + stderr }));
  });
}

test("audits the saved blocks under the node's schedule, exit 0", async () => {
  const { code, out } = await run("--blocks", "100");
  assert.equal(code, 0, out);
  assert.match(out, /^100 blocks, \d+ to \d+, under the blob schedule in force since 2026-01-07: target 14 blobs, max 21, update fraction 11,684,671/);
  assert.match(out, /check: excess blob gas matches the header on 100 of 100 blocks/);
  assert.match(out, new RegExp(`check: eth_blobBaseFee, [\\d,]+ wei, is block ${Number(latest)}'s own blob base fee`));
  assert.match(out, /EIP-7918's reserve price bound \d+ of 100 blocks/);
});

test("--json has the counts and the check results", async () => {
  const { code, out } = await run("--blocks", "50", "--json");
  assert.equal(code, 0, out);
  const report = JSON.parse(out);
  assert.equal(report.audited, 50);
  assert.equal(report.last, Number(latest));
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.rpcFee.is, "own");
  // Worked out here from the last 51 saved headers: blobs per block, and the reserve price on each parent.
  const { GAS_PER_BLOB, reservePriceBinds } = await import("../src/blob.ts");
  const { parseHeader } = await import("../src/audit.ts");
  const window = headers.slice(-51).map((h) => parseHeader(h as unknown as Parameters<typeof parseHeader>[0]));
  const { target, max } = ethConfig.current.blobSchedule;
  const counts = window.slice(1).map((h) => Number(h.blobGasUsed / GAS_PER_BLOB));
  assert.deepEqual(report.blobs, { total: counts.reduce((a, b) => a + b, 0), atOrAboveTarget: counts.filter((c) => c >= target).length, full: counts.filter((c) => c >= max).length });
  assert.equal(report.reserveBound, window.slice(0, -1).filter((p) => reservePriceBinds(p, ethConfig.current.blobSchedule)).length);
});

test("a header whose excess blob gas breaks the rules exits 1 and names the block", async () => {
  tamperedBlock = Number(latest) - 3;
  try {
    const { code, out } = await run("--blocks", "20");
    assert.equal(code, 1, out);
    assert.match(out, /check: excess blob gas matches the header on 18 of 20 blocks/, "the tampered block, and the next, whose parent it is");
    assert.match(out, new RegExp(`block ${tamperedBlock}: expected [\\d,]+, header has [\\d,]+`));
  } finally {
    tamperedBlock = undefined;
  }
});

test("an eth_blobBaseFee the rules don't give exits 1", async () => {
  wrongFee = true;
  try {
    const { code, out } = await run("--blocks", "10");
    assert.equal(code, 1, out);
    assert.match(out, /check: eth_blobBaseFee said [\d,]+ wei at block \d+, but the rules give [\d,]+/);
  } finally {
    wrongFee = false;
  }
});

test("blocks from before the schedule took effect are left out", async () => {
  activationAfter = Number(latest) - 10;
  try {
    const { code, out } = await run("--blocks", "30", "--json");
    assert.equal(code, 0, out);
    const report = JSON.parse(out);
    assert.equal(report.audited, 10, "only blocks whose parent came at or after activation");
    assert.equal(report.skipped, 20);
  } finally {
    activationAfter = undefined;
  }
});

test("without eth_config, it says to pass --schedule, and works with it", async () => {
  noConfig = true;
  try {
    const missing = await run("--blocks", "10");
    assert.equal(missing.code, 2, missing.out);
    assert.match(missing.out, /may not support eth_config \(EIP-7910\), so pass --schedule/);
    const given = await run("--blocks", "10", "--schedule", "14,21,11684671");
    assert.equal(given.code, 0, given.out);
    assert.match(given.out, /under the blob schedule given: target 14 blobs/);
    const wrong = await run("--blocks", "10", "--schedule", "6,9,5007716");
    assert.equal(wrong.code, 1, "Pectra's schedule doesn't fit these blocks");
  } finally {
    noConfig = false;
  }
});

test("a rate-limited node is asked again", async () => {
  rateLimits = 2;
  const { code, out } = await run("--blocks", "5");
  assert.equal(code, 0, out);
  assert.equal(rateLimits, 0);
});

test("bad arguments and an unreachable node exit 2", async () => {
  for (const args of [["--blocks", "0"], ["--blocks", "1001"], ["--schedule", "14,21"], ["--schedule", "21,14,100"]]) {
    const bad = await run(...args);
    assert.equal(bad.code, 2, `${args}: ${bad.out}`);
    assert.match(bad.out, /usage: blob-fee-audit/);
  }
  const closed = await new Promise<{ code: number; out: string }>((resolve) =>
    execFile(process.execPath, [MAIN, "--rpc", "http://127.0.0.1:1"], (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, out: stdout + stderr })),
  );
  assert.equal(closed.code, 2, closed.out);
});

test("--counterfactual adds the replay, in text and JSON", async () => {
  const text = await run("--blocks", "60", "--counterfactual");
  assert.equal(text.code, 0, text.out);
  assert.match(text.out, /without EIP-7918, the same blobs would have taken the fee from [\d,]+ wei at block \d+ (down to the 1-wei minimum by block \d+, \d+ blocks in|to [\d,]+ wei by block \d+); with it, the fee was [\d,]+ wei at block \d+/);
  const json = JSON.parse((await run("--blocks", "60", "--counterfactual", "--json")).out);
  assert.equal(json.counterfactual.from, Number(headers.at(-61)!.number));
  const plain = JSON.parse((await run("--blocks", "60", "--json")).out);
  assert.equal(plain.counterfactual, undefined);
});
