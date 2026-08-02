/// <reference lib="dom" />

// This verifier is excluded from the published graph, so Playwright stays a tool-only dependency.
// deno-lint-ignore no-import-prefix
import { chromium, type Page } from "npm:playwright@1.62.1";

const hostname = "127.0.0.1";
const timeoutMilliseconds = 60_000;
const playgroundDirectory = new URL("../playground/dist/", import.meta.url);
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

let port: number | undefined;
const server = Deno.serve({
  hostname,
  port: 0,
  onListen: (address) => {
    port = address.port;
  },
}, servePlaygroundFile);
if (port === undefined) throw new Error("playground browser server did not report its port");

const browser = await chromium.launch({
  headless: false,
  args: [
    "--disable-vulkan-surface",
    "--enable-features=Vulkan",
    "--enable-unsafe-webgpu",
    "--use-angle=vulkan",
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const browserFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserFailures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserFailures.push(`page: ${error.message}`));

  await page.goto(`http://${hostname}:${port}/`, { waitUntil: "domcontentloaded" });
  const webGpuAvailable = await page.evaluate(() => navigator.gpu !== undefined);
  if (!webGpuAvailable) {
    throw new Error("playground Chromium exposes no WebGPU despite the WebGPU launch flags");
  }
  const adapter = await page.evaluate(async () => {
    const info = (await navigator.gpu.requestAdapter())?.info;
    return info === undefined ? undefined : {
      architecture: info.architecture,
      description: info.description,
      device: info.device,
      vendor: info.vendor,
    };
  });

  console.log(`Adapter: ${JSON.stringify(adapter)}`);
  await verifyPlaygroundShell(page);
  if (isSoftwareAdapter(adapter) && Deno.args.includes("--require-hardware")) {
    throw new Error(
      `playground measurement requires hardware WebGPU; received ${JSON.stringify(adapter)}`,
    );
  }
  const cold = await compileExample(page, "tour", "cold page");
  const resident = await compileExample(page, "tour", "resident");
  const simd = await compileExample(page, "simd arithmetic", "SIMD arithmetic");
  const stress = await compileExample(page, "stress project", "stress project");
  const userAgent = await page.evaluate(() => navigator.userAgent);

  console.log(`Browser: ${userAgent}`);
  printMeasurement("Cold tour", cold);
  printMeasurement("Resident tour", resident);
  printMeasurement("SIMD arithmetic", simd);
  printMeasurement("Stress project", stress);

  if (browserFailures.length > 0) {
    throw new Error(`playground browser reported failures:\n${browserFailures.join("\n")}`);
  }
} finally {
  await browser.close();
  await server.shutdown();
}

interface BrowserMeasurement {
  readonly wallMilliseconds: number;
  readonly maximumFrameDelayMilliseconds: number;
  readonly responsiveFrames: number;
  readonly stages: Readonly<Record<string, number>>;
  readonly status: string;
}

interface BrowserAdapter {
  readonly architecture: string;
  readonly description: string;
  readonly device: string;
  readonly vendor: string;
}

async function verifyPlaygroundShell(page: Page): Promise<void> {
  await page.getByRole("button", { name: "tour", exact: true }).click();
  await page.getByRole("button", { name: "Run", exact: true }).waitFor();
  await page.getByLabel("Disable cache (cold run)").waitFor();
  const source = await page.getByLabel("Blot source").inputValue();
  if (source.length === 0) throw new Error("playground tour loaded no source");
}

function isSoftwareAdapter(adapter: BrowserAdapter | undefined): boolean {
  if (adapter === undefined) return true;
  const identity =
    `${adapter.vendor} ${adapter.architecture} ${adapter.device} ${adapter.description}`;
  return /(swiftshader|llvmpipe|lavapipe)/i.test(identity);
}

async function compileExample(
  page: Page,
  example: string,
  run: string,
): Promise<BrowserMeasurement> {
  await page.getByRole("button", { name: example, exact: true }).click();
  await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & {
      playgroundResponsivenessProbe?: ResponsivenessProbe;
    };
    const probe: ResponsivenessProbe = {
      frames: 0,
      lastFrameMilliseconds: 0,
      maximumFrameDelayMilliseconds: 0,
      request: 0,
    };
    const observeFrame = (now: number) => {
      probe.frames++;
      if (probe.lastFrameMilliseconds !== 0) {
        probe.maximumFrameDelayMilliseconds = Math.max(
          probe.maximumFrameDelayMilliseconds,
          now - probe.lastFrameMilliseconds,
        );
      }
      probe.lastFrameMilliseconds = now;
      probe.request = requestAnimationFrame(observeFrame);
    };
    probe.request = requestAnimationFrame(observeFrame);
    browser.playgroundResponsivenessProbe = probe;
  });
  const started = performance.now();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  try {
    await page.waitForFunction(
      () => {
        const status = document.getElementById("status");
        return status?.dataset.tone === "ok" || status?.dataset.tone === "error";
      },
      undefined,
      { timeout: timeoutMilliseconds },
    );
  } catch (cause) {
    const status = await page.locator("#status").textContent();
    throw new Error(
      `${run} Blot tour exceeded ${timeoutMilliseconds} ms; ` +
        `last status was ${JSON.stringify(status)}`,
      { cause },
    );
  }

  const status = await page.locator("#status").innerText();
  const tone = await page.locator("#status").getAttribute("data-tone");
  if (tone !== "ok") {
    const result = await page.locator("#result").innerText();
    throw new Error(
      `${run} Blot tour failed with status ` +
        `${JSON.stringify(status)}:\n${result}`,
    );
  }

  await page.getByRole("heading", { name: "Result", exact: true }).waitFor();
  if (!(await page.locator("#download").isVisible())) {
    throw new Error(`${run} emitted no downloadable Wasm`);
  }

  const responsiveness = await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & {
      playgroundResponsivenessProbe?: ResponsivenessProbe;
    };
    const probe = browser.playgroundResponsivenessProbe;
    if (probe === undefined) throw new Error("playground responsiveness probe was not started");
    cancelAnimationFrame(probe.request);
    delete browser.playgroundResponsivenessProbe;
    return {
      frames: probe.frames,
      maximumFrameDelayMilliseconds: probe.maximumFrameDelayMilliseconds,
    };
  });
  if (responsiveness.frames < 2) {
    throw new Error(
      `${run} rendered only ${responsiveness.frames} animation frame(s) while compiling`,
    );
  }
  if (responsiveness.maximumFrameDelayMilliseconds >= 1_000) {
    throw new Error(
      `${run} blocked animation frames for ${
        responsiveness.maximumFrameDelayMilliseconds.toFixed(1)
      } ms while compiling`,
    );
  }

  const stages = await page.locator("#stages").evaluate((stageList) => {
    const measurements: Record<string, number> = {};
    const labels = stageList.querySelectorAll("dt");
    const values = stageList.querySelectorAll("dd");
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index]?.textContent;
      const value = values[index]?.textContent;
      if (label === null || label === undefined || value === null || value === undefined) continue;
      const milliseconds = Number.parseFloat(value);
      if (Number.isFinite(milliseconds)) measurements[label] = milliseconds;
    }
    return measurements;
  });

  return {
    wallMilliseconds: performance.now() - started,
    maximumFrameDelayMilliseconds: responsiveness.maximumFrameDelayMilliseconds,
    responsiveFrames: responsiveness.frames,
    stages,
    status,
  };
}

interface ResponsivenessProbe {
  frames: number;
  lastFrameMilliseconds: number;
  maximumFrameDelayMilliseconds: number;
  request: number;
}

async function servePlaygroundFile(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }

  const requestedPath = new URL(request.url).pathname === "/"
    ? "index.html"
    : new URL(request.url).pathname.slice(1);
  const file = new URL(requestedPath, playgroundDirectory);
  if (!file.href.startsWith(playgroundDirectory.href)) {
    return new Response("invalid path", { status: 400 });
  }

  try {
    const bytes = await Deno.readFile(file);
    const extension = file.pathname.slice(file.pathname.lastIndexOf("."));
    return new Response(request.method === "HEAD" ? null : bytes, {
      headers: {
        "cache-control": "no-store",
        "content-type": contentTypes[extension] ?? "application/octet-stream",
      },
    });
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return new Response("not found", { status: 404 });
    throw cause;
  }
}

function printMeasurement(label: string, measurement: BrowserMeasurement): void {
  console.log(
    `${label}: ${measurement.wallMilliseconds.toFixed(1)} ms, ` +
      `${measurement.responsiveFrames} frames, ` +
      `${measurement.maximumFrameDelayMilliseconds.toFixed(1)} ms maximum frame delay`,
  );
  for (const [stage, milliseconds] of Object.entries(measurement.stages)) {
    console.log(`  ${stage}: ${milliseconds.toFixed(1)} ms`);
  }
  console.log(`  ${measurement.status}`);
}
