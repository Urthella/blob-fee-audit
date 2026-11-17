#!/usr/bin/env node
// blob-fee-audit: recomputes Ethereum's blob fee for the latest blocks from the rules, EIP-4844 as
// Osaka changed it with EIP-7918, under the blob schedule the node reports through eth_config.
// Exits 1 if a header or eth_blobBaseFee disagrees with the rules, and 2 on errors.

import { parseArgs } from "node:util";

import { type Config, audit, collect, config, describe, exitCode, parseHeader } from "./audit.ts";
import { Rpc } from "./rpc.ts";

const USAGE = "usage: blob-fee-audit [--rpc URL] [--blocks N] [--schedule TARGET,MAX,FRACTION] [--json]";

const { values } = parseArgs({
  options: {
    rpc: { type: "string", default: "https://ethereum-rpc.publicnode.com" },
    blocks: { type: "string", default: "100" },
    schedule: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const blocks = Number(values.blocks);
const given = values.schedule?.split(",").map(Number);
const bad = [
  !Number.isInteger(blocks) || blocks < 1 || blocks > 1000 ? `--blocks must be 1 to 1000: ${values.blocks}` : "",
  given && (given.length !== 3 || !given.every((n) => Number.isInteger(n) && n > 0) || given[0] > given[1]) ? `--schedule takes TARGET,MAX,FRACTION: ${values.schedule}` : "",
].filter(Boolean);

if (values.help) {
  console.error(USAGE);
} else if (bad.length) {
  console.error([...bad, USAGE].join("\n"));
  process.exitCode = 2;
} else {
  try {
    const rpc = new Rpc(values.rpc);
    const cfg: Config = given ? { schedule: { target: given[0], max: given[1], baseFeeUpdateFraction: given[2] }, activationTime: 0 } : await config(rpc).catch((error: Error) => {
      throw new Error(`${error.message}; this RPC may not support eth_config (EIP-7910), so pass --schedule`);
    });
    const { headers, snapshot } = await collect(rpc, blocks);
    // The snapshot block may be newer than the headers read before it.
    const snapshotHeader = headers.find((h) => h.number === snapshot.block) ?? parseHeader(await rpc.call("eth_getBlockByNumber", [`0x${snapshot.block.toString(16)}`, false]));
    const report = audit(headers, cfg, snapshot, snapshotHeader);
    console.log(values.json ? JSON.stringify(report, null, 2) : describe(report));
    // Not process.exit(): it can trip a libuv assertion on Windows.
    process.exitCode = exitCode(report);
  } catch (error) {
    console.error(`blob-fee-audit: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
