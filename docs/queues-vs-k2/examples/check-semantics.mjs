import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const doc = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(doc, "../..");
const temporary = mkdtempSync(join(tmpdir(), "cf-transport-explainer-"));
const writing = process.argv.includes("--write");
const number = value => Number(value["#bigint"]);

function trace(file, main, step, invariant) {
	const output = join(temporary, `${main}.itf.json`);
	const result = spawnSync("pnpm", ["exec", "quint", "run", file, "--main", main, "--step", step,
		"--invariant", invariant, "--max-steps", "20", "--max-samples", "100", "--seed", "7",
		"--out-itf", output, "--mbt", "--backend", "typescript", "--verbosity", "0"], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout + result.stderr, /Invariant violated/);
	// The negated reachability property fails when the desired state is reached.
	return JSON.parse(readFileSync(output, "utf8")).states;
}
function factFile(name, value) {
	const path = join(doc, "figures", name);
	if (writing) writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
	else assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), value, `Facts drifted: ${name}`);
}

try {
	const queue = trace("models/queues.qnt", "queues", "stepSafe", "noRetryHandled");
	const sent = queue.find(state => state["queues::Msg::pending"] === true);
	const queueEnd = queue.at(-1);
	assert.ok(sent);
	assert.equal(queueEnd["queues::Msg::acked"], true);
	assert.equal(queueEnd["queues::Msg::pending"], false);
	assert.equal(number(queueEnd.effectCount), 1);

	const log = trace("models/k2.qnt", "k2",
		"any {produce, consume, processSafe, ack, all {Analytics::cursor == 2, consumeAudit}, finishAudit}", "noFanoutCompleted");
	const produced = log.find(state => state.log.length === 2);
	const searchAcked = log.findIndex(state => number(state["k2::Analytics::cursor"]) === 2);
	const auditLeased = log.findIndex(state => number(state["k2::Audit::holder"]) === 1);
	const middle = log[searchAcked];
	const logEnd = log.at(-1);
	assert.ok(produced && searchAcked > 0 && auditLeased > searchAcked);
	assert.equal(middle.log.length, 2);
	assert.equal(number(middle["k2::Audit::cursor"]), 0);
	assert.equal(logEnd.log.length, 2);
	assert.equal(number(logEnd["k2::Analytics::cursor"]), 2);
	assert.equal(number(logEnd["k2::Audit::cursor"]), 2);

	const observations = { queue: { beforePending: 1, afterPending: 0, effects: number(queueEnd.effectCount) },
		k2: { retained: middle.log.length, searchCursor: number(middle["k2::Analytics::cursor"]),
			auditCursor: number(middle["k2::Audit::cursor"]), finalRetained: logEnd.log.length } };
	factFile("observations.json", observations);
	factFile("ack.facts.json", { source: ["models/queues.qnt", "models/k2.qnt", "Quint ITF / seed 7"],
		labels: ["Queues", "ack 前", "未完了 1 件", "ack 後", "未完了 0 件", "K2", "保持ログ 2 件", "検索 2 件完了", "監査 0 件完了"],
		forbidden: ["一度だけ配送", "K2 の ack でログを削除", "永遠に保持"] });
	factFile("fanout.expect.json", { format: "vlmkit-anim/expect@1", nodes: ["log", "search", "audit"],
		messages: ["log->search:E1・E2 を読む", "search->log:検索の batch ack", "log->audit:同じ E1・E2 を読む", "audit->log:監査の batch ack"] });
	console.log(`Queues: pending ${observations.queue.beforePending} -> ${observations.queue.afterPending}; effectCount=${observations.queue.effects}`);
	console.log(`K2: retained=${observations.k2.retained}; search cursor=${observations.k2.searchCursor}; audit cursor=${observations.k2.auditCursor}`);
	console.log(`K2: both subscriptions acked; retained=${observations.k2.finalRetained}`);
	console.log("figure facts: Quint ITF observations match");
} finally { rmSync(temporary, { recursive: true, force: true }); }
