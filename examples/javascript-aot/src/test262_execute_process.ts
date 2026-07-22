import {
  executeTest262Batch,
  type Test262ExecutionBatchRequest,
  type Test262ExecutionBatchResponse,
} from "./test262_execute.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

let response: Test262ExecutionBatchResponse;
try {
  const request = JSON.parse(
    decoder.decode(await readStandardInput()),
  ) as Test262ExecutionBatchRequest;
  response = { ok: true, result: await executeTest262Batch(request) };
} catch (error) {
  response = {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
  };
}
await Deno.stdout.write(encoder.encode(JSON.stringify(response)));

async function readStandardInput(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const input = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return input;
}
