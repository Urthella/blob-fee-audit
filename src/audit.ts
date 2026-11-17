// Audits recent blocks: each block's excess blob gas must be what the rules give from its parent,
// and the node's eth_blobBaseFee must be the fee those rules give. Along the way it reports blob
// use against the target and how often EIP-7918's reserve price held the fee up.

import { GAS_PER_BLOB, type Header, MIN_BLOB_BASE_FEE, type Schedule, blobBaseFee, nextExcessBlobGas, nextExcessBlobGasBeforeOsaka, reservePriceBinds } from "./blob.ts";
import type { Rpc } from "./rpc.ts";

export interface Config {
  schedule: Schedule;
  /** Unix seconds from which the schedule applies; 0 when it was given by hand. */
  activationTime: number;
}

interface RawHeader {
  number: string;
  timestamp: string;
  baseFeePerGas?: string;
  blobGasUsed?: string;
  excessBlobGas?: string;
}

export function parseHeader(raw: RawHeader): Header {
  if (raw.baseFeePerGas === undefined || raw.blobGasUsed === undefined || raw.excessBlobGas === undefined) {
    throw new Error(`block ${Number(raw.number)} has no blob fields: the chain is from before EIP-4844`);
  }
  return { number: Number(raw.number), timestamp: Number(raw.timestamp), baseFeePerGas: BigInt(raw.baseFeePerGas), blobGasUsed: BigInt(raw.blobGasUsed), excessBlobGas: BigInt(raw.excessBlobGas) };
}

/** The blob schedule in force, from eth_config (EIP-7910). */
export async function config(rpc: Rpc): Promise<Config> {
  const result = await rpc.call<{ current?: { activationTime: number; blobSchedule?: Schedule } }>("eth_config");
  const current = result?.current;
  if (!current?.blobSchedule) throw new Error("eth_config reported no blob schedule");
  return { schedule: current.blobSchedule, activationTime: Number(current.activationTime) };
}

const BATCH = 25;

/** The latest `count` blocks and their parent, and eth_blobBaseFee read with no new block between. */
export async function collect(rpc: Rpc, count: number): Promise<{ headers: Header[]; snapshot: { block: number; fee: bigint } }> {
  const latest = Number(await rpc.call<string>("eth_blockNumber"));
  const numbers = Array.from({ length: count + 1 }, (_, i) => latest - count + i).filter((n) => n >= 0);
  const headers: Header[] = [];
  for (let i = 0; i < numbers.length; i += BATCH) {
    const raw = await rpc.batch<RawHeader>(numbers.slice(i, i + BATCH).map((n) => ({ method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false] })));
    headers.push(...raw.map(parseHeader));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const [before, fee, after] = await rpc.batch<string>([
      { method: "eth_blockNumber", params: [] },
      { method: "eth_blobBaseFee", params: [] },
      { method: "eth_blockNumber", params: [] },
    ]);
    if (before === after) return { headers, snapshot: { block: Number(before), fee: BigInt(fee) } };
  }
  throw new Error("a new block kept arriving while eth_blobBaseFee was read");
}

export interface Report {
  schedule: Schedule;
  activationTime: number;
  first: number;
  last: number;
  audited: number;
  /** Blocks left out because they or their parent came before the schedule took effect. */
  skipped: number;
  mismatches: { block: number; expected: string; header: string }[];
  blobs: { total: number; atOrAboveTarget: number; full: number };
  /** Wei per blob gas. */
  fee: { min: string; max: string };
  reserveBound: number;
  /** Whether eth_blobBaseFee was the fee of the block it was read at, or of the one after. */
  rpcFee: { block: number; value: string; is: "own" | "next" | "neither"; expected: string };
  /**
   * With `counterfactual`, the same blocks replayed under the rule before Osaka: from the first
   * audited block's parent and its real excess, each block's real blob use, but no reserve price.
   * Fees are wei per blob gas.
   */
  counterfactual?: { from: number; start: string; end: string; actual: string; min: string; lower: number; minimumAt?: number };
}

export function audit(headers: Header[], cfg: Config, snapshot: { block: number; fee: bigint }, snapshotHeader?: Header, options: { counterfactual?: boolean } = {}): Report {
  const { schedule } = cfg;
  const mismatches: Report["mismatches"] = [];
  let audited = 0;
  let skipped = 0;
  let reserveBound = 0;
  const blobs = { total: 0, atOrAboveTarget: 0, full: 0 };
  let min: bigint | undefined;
  let max: bigint | undefined;
  let replay: { from: number; start: bigint; excess: bigint; fee: bigint; min: bigint; lower: number; minimumAt?: number } | undefined;
  for (let i = 1; i < headers.length; i++) {
    const parent = headers[i - 1];
    const block = headers[i];
    if (parent.timestamp < cfg.activationTime) {
      skipped++;
      continue;
    }
    audited++;
    if (options.counterfactual) {
      replay ??= { from: parent.number, start: blobBaseFee(parent.excessBlobGas, schedule), excess: parent.excessBlobGas, fee: 0n, min: blobBaseFee(parent.excessBlobGas, schedule), lower: 0 };
      replay.excess = nextExcessBlobGasBeforeOsaka({ ...parent, excessBlobGas: replay.excess }, schedule);
      replay.fee = blobBaseFee(replay.excess, schedule);
      if (replay.fee < replay.min) replay.min = replay.fee;
      if (replay.fee === MIN_BLOB_BASE_FEE) replay.minimumAt ??= block.number;
      if (replay.fee < blobBaseFee(block.excessBlobGas, schedule)) replay.lower++;
    }
    const expected = nextExcessBlobGas(parent, schedule);
    if (expected !== block.excessBlobGas) mismatches.push({ block: block.number, expected: String(expected), header: String(block.excessBlobGas) });
    if (reservePriceBinds(parent, schedule)) reserveBound++;
    const count = Number(block.blobGasUsed / GAS_PER_BLOB);
    blobs.total += count;
    if (count >= schedule.target) blobs.atOrAboveTarget++;
    if (count >= schedule.max) blobs.full++;
    const fee = blobBaseFee(block.excessBlobGas, schedule);
    if (min === undefined || fee < min) min = fee;
    if (max === undefined || fee > max) max = fee;
  }
  const at = snapshotHeader ?? headers.find((h) => h.number === snapshot.block) ?? headers.at(-1)!;
  const ofThat = blobBaseFee(at.excessBlobGas, schedule);
  const ofNext = blobBaseFee(nextExcessBlobGas(at, schedule), schedule);
  const is = snapshot.fee === ofThat ? "own" : snapshot.fee === ofNext ? "next" : "neither";
  return {
    schedule,
    activationTime: cfg.activationTime,
    first: headers[1]?.number ?? headers[0].number,
    last: headers.at(-1)!.number,
    audited,
    skipped,
    mismatches,
    blobs,
    fee: { min: String(min ?? 0n), max: String(max ?? 0n) },
    reserveBound,
    rpcFee: { block: at.number, value: String(snapshot.fee), is, expected: String(ofThat) },
    ...(replay && {
      counterfactual: {
        from: replay.from,
        start: String(replay.start),
        end: String(replay.fee),
        actual: String(blobBaseFee(headers.at(-1)!.excessBlobGas, schedule)),
        min: String(replay.min),
        lower: replay.lower,
        ...(replay.minimumAt !== undefined && { minimumAt: replay.minimumAt }),
      },
    }),
  };
}

/** 0 when every check holds, 1 when a header or eth_blobBaseFee disagrees with the rules. */
export const exitCode = (report: Report) => (report.mismatches.length || report.rpcFee.is === "neither" ? 1 : 0);

const number = (n: number | bigint | string) => BigInt(n).toLocaleString("en-US");
const gwei = (wei: bigint) => (Number(wei) / 1e9).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function describe(report: Report): string {
  const { schedule, blobs } = report;
  const since = report.activationTime ? `the blob schedule in force since ${new Date(report.activationTime * 1000).toISOString().slice(0, 10)}` : "the blob schedule given";
  const lines = [
    `${report.audited} blocks, ${report.first} to ${report.last}, under ${since}: target ${schedule.target} blobs, max ${schedule.max}, update fraction ${number(schedule.baseFeeUpdateFraction)}`,
  ];
  if (report.skipped) lines.push(`  ${report.skipped} earlier blocks were left out: they came before that schedule`);
  if (report.audited) {
    const average = (blobs.total / report.audited).toFixed(1);
    lines.push(`  blobs: ${average} a block on average; ${blobs.atOrAboveTarget} blocks at or above the target, ${blobs.full} full`);
    lines.push(
      `  blob base fee: ${number(report.fee.min)} to ${number(report.fee.max)} wei; a blob cost ${gwei(BigInt(report.fee.min) * GAS_PER_BLOB)} to ${gwei(BigInt(report.fee.max) * GAS_PER_BLOB)} gwei`,
    );
    lines.push(`  EIP-7918's reserve price bound ${report.reserveBound} of ${report.audited} blocks: the execution base fee set the blob fee's floor`);
    const c = report.counterfactual;
    if (c) {
      const replayed =
        c.minimumAt !== undefined
          ? `down to the 1-wei minimum by block ${c.minimumAt}, ${c.minimumAt - c.from} blocks in`
          : `to ${number(c.end)} wei by block ${report.last}`;
      lines.push(`  without EIP-7918, the same blobs would have taken the fee from ${number(c.start)} wei at block ${c.from} ${replayed}; with it, the fee was ${number(c.actual)} wei at block ${report.last}`);
    }
  }
  lines.push(`  check: excess blob gas matches the header on ${report.audited - report.mismatches.length} of ${report.audited} blocks`);
  for (const miss of report.mismatches.slice(0, 5)) lines.push(`    block ${miss.block}: expected ${number(miss.expected)}, header has ${number(miss.header)}`);
  const { rpcFee } = report;
  lines.push(
    rpcFee.is === "neither"
      ? `  check: eth_blobBaseFee said ${number(rpcFee.value)} wei at block ${rpcFee.block}, but the rules give ${number(rpcFee.expected)}`
      : rpcFee.is === "own"
        ? `  check: eth_blobBaseFee, ${number(rpcFee.value)} wei, is block ${rpcFee.block}'s own blob base fee`
        : `  check: eth_blobBaseFee, ${number(rpcFee.value)} wei, is the blob base fee of the block after ${rpcFee.block}`,
  );
  return lines.join("\n");
}
