import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const assetsDirectory = path.resolve("dist/client/assets");
const workerChunk = (await readdir(assetsDirectory)).find((name) => name.startsWith("import-worker-") && name.endsWith(".js"));
assert.ok(workerChunk, "The production spreadsheet Worker chunk must exist");

const workerUrl = pathToFileURL(path.join(assetsDirectory, workerChunk)).href;
const bootstrap = `
  const { parentPort } = require("node:worker_threads");
  global.self = global;
  global.postMessage = (value) => parentPort.postMessage(value);
  parentPort.on("message", (value) => global.onmessage?.({ data: value }));
  import(${JSON.stringify(workerUrl)}).then(() => parentPort.postMessage({ bootstrapReady: true }));
`;
const worker = new Worker(bootstrap, { eval: true });
const nextMessage = () => new Promise((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
});

assert.deepEqual(await nextMessage(), { bootstrapReady: true });
const source = await readFile(new URL("./fixtures/spreadsheets/valid.xlsx", import.meta.url));
const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
worker.postMessage({ type: "parse", buffer }, [buffer]);
const parsed = await nextMessage();
assert.equal(parsed.ok, true);
assert.equal(parsed.status, "ready");
assert.equal(parsed.sheetName, "Compu");
assert.equal(parsed.rows.length, 2);
assert.equal(parsed.formattedRows[0][1], "012345678905");
assert.equal(parsed.rows[1][0], "Vitamina C");
await worker.terminate();

console.log(`Production spreadsheet Worker parsed ${parsed.rows.length} products from ${workerChunk}`);
