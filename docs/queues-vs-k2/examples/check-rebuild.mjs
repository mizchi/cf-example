import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const doc = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = new URL(`/api/pipeline/${crypto.randomUUID()}`, process.env.EXPLAINER_BASE_URL ?? "http://localhost:5173").href;
async function call(path, body) {
	const response = await fetch(`${base}${path}`, body === undefined ? {} : {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	});
	assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
	return response.json();
}
const initial = await call("/projections");
assert.equal(initial.transport, "local", "Use local transport for this demonstration");
for (const value of ["old", "latest"]) await call("/documents/article", { value });
await call("/documents/article/publish", {});
await call("/consume/search", {});
await call("/consume/audit", {});
const before = await call("/projections");
assert.equal(before.search.documents[0].version, 2);
assert.equal(before.audit.totalUpdates, 2);
await call("/projections/search/reset", {});
const reset = await call("/projections");
assert.notEqual(reset.search.subscription, before.search.subscription);
assert.equal(reset.search.documents.length, 0);
assert.equal(reset.audit.totalUpdates, 2);
const consumed = await call("/consume/search", {});
const rebuilt = await call("/projections");
assert.equal(consumed.records, 2);
assert.deepEqual(rebuilt.search.documents, before.search.documents);
assert.equal(rebuilt.audit.totalUpdates, 2);
const facts = { source: ["src/pipeline-api.ts", "src/event-projection-store.ts", "src/local-k2-stream.ts", "local HTTP API observations"],
	labels: ["保持ログ", "E1 / E2", "新しい読者", "subscription", "earliest", "検索 v2", "監査は 2 件のまま"],
	edges: ["log->newSearch", "newSearch->index"], forbidden: ["無期限", "監査もリセット"] };
const path = join(doc, "figures/rebuild.facts.json");
if (process.argv.includes("--write")) writeFileSync(path, JSON.stringify(facts, null, 2) + "\n");
else assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), facts);
console.log(`Rebuild: search v${before.search.documents[0].version} -> empty -> v${rebuilt.search.documents[0].version}; replayed=${consumed.records}`);
console.log(`Rebuild: audit ${before.audit.totalUpdates} -> ${reset.audit.totalUpdates} -> ${rebuilt.audit.totalUpdates}; subscription changed`);
console.log("figure facts: local HTTP rebuild observations match");
