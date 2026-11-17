// Saves real mainnet data for the offline tests: eth_config, 120 consecutive block headers with
// the fields the audit reads, and eth_blobBaseFee read with no new block in between.
//
//   node scripts/fetch-fixtures.ts [RPC_URL]

import { writeFileSync } from "node:fs";

import { Rpc } from "../src/rpc.ts";

const rpc = new Rpc(process.argv[2] ?? "https://ethereum-rpc.publicnode.com");
const dir = new URL("../test/fixtures/", import.meta.url);
const config = await rpc.call("eth_config");
const latest = Number(await rpc.call<string>("eth_blockNumber"));
const keep = ({ number, timestamp, baseFeePerGas, blobGasUsed, excessBlobGas }: Record<string, string>) => ({ number, timestamp, baseFeePerGas, blobGasUsed, excessBlobGas });
const headers = [];
for (let n = latest - 119; n <= latest; n += 20) {
  const batch = await rpc.batch<Record<string, string>>(Array.from({ length: Math.min(20, latest - n + 1) }, (_, i) => ({ method: "eth_getBlockByNumber", params: [`0x${(n + i).toString(16)}`, false] })));
  headers.push(...batch.map(keep));
}
let snapshot;
for (;;) {
  const [before, fee, after] = await rpc.batch<string>([{ method: "eth_blockNumber", params: [] }, { method: "eth_blobBaseFee", params: [] }, { method: "eth_blockNumber", params: [] }]);
  if (before !== after) continue;
  snapshot = { block: before, fee, header: keep(await rpc.call("eth_getBlockByNumber", [before, false])) };
  break;
}
writeFileSync(new URL("eth_config.json", dir), JSON.stringify(config, null, 1) + "\n");
writeFileSync(new URL("headers.json", dir), JSON.stringify(headers, null, 1) + "\n");
writeFileSync(new URL("snapshot.json", dir), JSON.stringify(snapshot, null, 1) + "\n");
console.log(`blocks ${Number(headers[0].number)} to ${Number(headers.at(-1)!.number)}; eth_blobBaseFee ${Number(snapshot.fee)} at ${Number(snapshot.block)}`);
