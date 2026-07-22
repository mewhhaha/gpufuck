import {
  probeTest262FrontendBatch,
  type Test262FrontendBatchRequest,
  type Test262FrontendBatchResponse,
} from "./test262_scan.ts";

const request = JSON.parse(
  await new Response(Deno.stdin.readable).text(),
) as Test262FrontendBatchRequest;
let response: Test262FrontendBatchResponse;
try {
  response = { ok: true, probes: await probeTest262FrontendBatch(request) };
} catch (error) {
  response = {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
  };
}
console.log(JSON.stringify(response));
