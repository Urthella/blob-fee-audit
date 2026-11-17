// A small JSON-RPC client that sends batches and waits out rate limits.

const TIMEOUT_MS = 30_000;
const ATTEMPTS = 5;

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`${message} (${code})`);
    this.code = code;
  }
}

export interface Call {
  method: string;
  params: unknown[];
}

export class Rpc {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const [result] = await this.batch<T>([{ method, params }]);
    return result;
  }

  /** Several calls in one request, with their results in the same order. */
  async batch<T>(calls: Call[]): Promise<T[]> {
    const body = JSON.stringify(calls.map((call, id) => ({ jsonrpc: "2.0", id, ...call })));
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "blob-fee-audit" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < ATTEMPTS) {
        const seconds = Number(response.headers.get("retry-after"));
        await new Promise((done) => setTimeout(done, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 500 * attempt));
        continue;
      }
      if (!response.ok) throw new Error(`${calls[0].method}: HTTP ${response.status}`);
      const replies = (await response.json()) as { id: number; result?: T; error?: { code: number; message: string } }[];
      if (!Array.isArray(replies)) throw new Error(`${calls[0].method}: the RPC didn't answer the batch`);
      return calls.map((call, id) => {
        const reply = replies.find((r) => r.id === id);
        if (!reply) throw new Error(`${call.method}: no reply`);
        if (reply.error) throw new RpcError(reply.error.code, `${call.method}: ${reply.error.message}`);
        return reply.result as T;
      });
    }
  }
}
