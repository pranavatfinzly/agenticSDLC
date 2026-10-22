import type { ChunkRecord } from "./types";
import { log } from "./log";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-code-3";
const DIMENSIONS = 1024;
const MAX_BATCH_ITEMS = 64;
const MAX_BATCH_TOKENS = 60_000; // well under Voyage's per-request cap
const MAX_INPUT_CHARS = 6_000;
const MAX_RETRIES = 10;

// Voyage accounts without a payment method are limited to 3 RPM / 10K TPM; paid accounts get far more.
// Defaults are the conservative free-tier numbers; raise them in .env once billing is set up.
const RPM = Number(process.env.VOYAGE_RPM) || 3;
const TPM = Number(process.env.VOYAGE_TPM) || 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const estimateTokens = (s: string) => Math.ceil(Math.min(s.length, MAX_INPUT_CHARS) / 3); // conservative for code

/** Sliding 60s window over requests and tokens; waits until the next request fits. */
class RateLimiter {
  private events: { t: number; tokens: number }[] = [];

  async acquire(tokens: number): Promise<void> {
    const budget = Math.floor(TPM * 0.9); // headroom for estimation error
    const need = Math.min(tokens, budget);
    for (;;) {
      const now = Date.now();
      this.events = this.events.filter((e) => now - e.t < 60_000);
      const usedTokens = this.events.reduce((s, e) => s + e.tokens, 0);
      if (this.events.length < RPM && usedTokens + need <= budget) {
        this.events.push({ t: now, tokens: need });
        return;
      }
      const oldest = this.events[0];
      const wait = oldest ? Math.max(500, 60_000 - (now - oldest.t) + 250) : 500;
      log("voyage", "embeddings", `pacing for rate limit (${RPM} RPM / ${TPM} TPM): waiting ${(wait / 1000).toFixed(0)}s`);
      await sleep(wait);
    }
  }
}

const limiter = new RateLimiter();

async function embedBatch(inputs: string[], inputType: "document" | "query"): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set");
  const tokens = inputs.reduce((s, x) => s + estimateTokens(x), 0);

  for (let attempt = 0; ; attempt++) {
    await limiter.acquire(tokens);
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        input: inputs.map((s) => s.slice(0, MAX_INPUT_CHARS)),
        model: MODEL,
        input_type: inputType,
        output_dimension: DIMENSIONS,
      }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
    }
    // 429s from per-minute windows clear after up to a minute; back off accordingly.
    const wait = res.status === 429 ? 20_000 + attempt * 5_000 : Math.min(30_000, 1_000 * 2 ** attempt);
    log("voyage", "embeddings", `HTTP ${res.status}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(wait);
  }
}

/** Split texts into batches bounded by item count and estimated tokens (and by the TPM budget). */
function makeBatches(texts: string[]): number[][] {
  const maxTokens = Math.min(MAX_BATCH_TOKENS, Math.floor(TPM * 0.9));
  const batches: number[][] = [];
  let cur: number[] = [];
  let curTokens = 0;
  texts.forEach((t, i) => {
    const tk = estimateTokens(t);
    if (cur.length && (cur.length >= MAX_BATCH_ITEMS || curTokens + tk > maxTokens)) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(i);
    curTokens += tk;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

/** Embed arbitrary texts in batches. Used for queries (inputType "query") and documents. */
export async function embedTexts(texts: string[], inputType: "document" | "query" = "document"): Promise<number[][]> {
  const out = new Array<number[]>(texts.length);
  for (const idxs of makeBatches(texts)) {
    const vecs = await embedBatch(idxs.map((i) => texts[i]), inputType);
    idxs.forEach((i, j) => (out[i] = vecs[j]));
  }
  return out;
}

/** Batch-embed chunks with voyage-code-3; returns chunks with `embedding` attached. */
export async function embedChunks(
  chunks: ChunkRecord[],
  onBatch?: (done: number, total: number) => void,
): Promise<ChunkRecord[]> {
  const texts = chunks.map((c) => `${c.filePath}${c.symbolName ? ` :: ${c.symbolName}` : ""}\n${c.code}`);
  const batches = makeBatches(texts);
  log("voyage", "embeddings", `${chunks.length} chunks in ${batches.length} request(s) at ${RPM} RPM / ${TPM} TPM`);
  const result: ChunkRecord[] = new Array(chunks.length);
  let done = 0;
  for (const idxs of batches) {
    const vectors = await embedBatch(idxs.map((i) => texts[i]), "document");
    idxs.forEach((i, j) => (result[i] = { ...chunks[i], embedding: vectors[j] }));
    done += idxs.length;
    onBatch?.(done, chunks.length);
  }
  return result;
}
