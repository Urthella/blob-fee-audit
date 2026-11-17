// Ethereum's blob fee rules: EIP-4844's exponential fee on excess blob gas, as Osaka changed it
// with EIP-7918, under the blob schedule (target, max, update fraction) that EIP-7840 and the
// blob-parameter-only forks of EIP-7892 set per fork.

export const GAS_PER_BLOB = 131_072n;
export const MIN_BLOB_BASE_FEE = 1n;
/** EIP-7918: a blob is priced at no less than 2^13 gas at the execution base fee. */
export const BLOB_BASE_COST = 8_192n;

export interface Schedule {
  target: number;
  max: number;
  baseFeeUpdateFraction: number;
}

export interface Header {
  number: number;
  timestamp: number;
  baseFeePerGas: bigint;
  blobGasUsed: bigint;
  excessBlobGas: bigint;
}

/** EIP-4844's integer approximation of factor * e^(numerator / denominator). */
export function fakeExponential(factor: bigint, numerator: bigint, denominator: bigint): bigint {
  let i = 1n;
  let output = 0n;
  let accumulator = factor * denominator;
  while (accumulator > 0n) {
    output += accumulator;
    accumulator = (accumulator * numerator) / (denominator * i);
    i += 1n;
  }
  return output / denominator;
}

/** The blob base fee, in wei per blob gas, of a block with this excess blob gas. */
export const blobBaseFee = (excessBlobGas: bigint, schedule: Schedule) => fakeExponential(MIN_BLOB_BASE_FEE, excessBlobGas, BigInt(schedule.baseFeeUpdateFraction));

/** Whether EIP-7918's reserve price binds after this block: its execution base fee prices a blob above its blob fee. */
export const reservePriceBinds = (parent: Header, schedule: Schedule) => BLOB_BASE_COST * parent.baseFeePerGas > GAS_PER_BLOB * blobBaseFee(parent.excessBlobGas, schedule);

/**
 * The excess blob gas of the block after `parent`. Below the target it resets to 0. Otherwise it
 * grows by what the parent used beyond the target, unless the reserve price binds: then it grows
 * by the parent's use scaled by (max - target) / max, so a cheap blob market can't drift down.
 */
export function nextExcessBlobGas(parent: Header, schedule: Schedule): bigint {
  const target = BigInt(schedule.target) * GAS_PER_BLOB;
  if (parent.excessBlobGas + parent.blobGasUsed < target) return 0n;
  if (reservePriceBinds(parent, schedule)) {
    return parent.excessBlobGas + (parent.blobGasUsed * BigInt(schedule.max - schedule.target)) / BigInt(schedule.max);
  }
  return parent.excessBlobGas + parent.blobGasUsed - target;
}
