import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const diagram = readFileSync(join(root, "docs/figures/claim-counterexample.mmd"), "utf8");
const source = readFileSync(join(root, "src/claim-store.ts"), "utf8");
const worker = readFileSync(join(root, "src/index.ts"), "utf8");
const model = readFileSync(join(root, "models/durable-object.qnt"), "utf8");
const temporary = mkdtempSync(join(tmpdir(), "claim-figure-"));

function trace(mode) {
	const output = join(temporary, `${mode}.itf.json`);
	const result = spawnSync("pnpm", [
		"exec", "quint", "run", "models/durable-object.qnt",
		"--main", "durableObject",
		"--step", mode === "safe" ? "stepSafe" : "stepNaive",
		"--invariant", "atMostOneClaim",
		"--max-steps", "4",
		"--max-samples", "100",
		"--seed", "7",
		"--out-itf", output,
		"--mbt", "--backend", "typescript",
	], { cwd: root, encoding: "utf8" });
	const expectedStatus = mode === "safe" ? 0 : 1;
	if (result.status !== expectedStatus) {
		throw new Error(`${mode}: unexpected Quint status ${result.status}\n${result.stdout}\n${result.stderr}`);
	}
	return JSON.parse(readFileSync(output, "utf8")).states.map((state) => ({
		action: state["mbt::actionTaken"],
		claimed: state.done,
		accepted: Number(state.accepted["#bigint"]),
	}));
}

try {
	const naive = trace("naive");
	const safe = trace("safe");
	const expectedNaive = [
		["init", false, 0],
		["readA", false, 0],
		["readB", false, 0],
		["finishA", true, 1],
		["finishB", true, 2],
	];
	for (const [index, [action, claimed, accepted]] of expectedNaive.entries()) {
		const state = naive[index];
		if (!state || state.action !== action || state.claimed !== claimed || state.accepted !== accepted) {
			throw new Error(`naive state ${index} differs from the figure: ${JSON.stringify(state)}`);
		}
		if (!diagram.includes(action) || !diagram.includes(`claimed=${claimed}, accepted=${accepted}`)) {
			throw new Error(`figure omits ${action} or its state`);
		}
	}
	if (naive.length !== expectedNaive.length || safe.at(-1)?.accepted !== 1) {
		throw new Error("unexpected trace length or safe result");
	}
	for (const [label, content, required] of [
		["Worker", worker, ["const claim =", "CLAIM.idFromName", "CLAIM.get"]],
		["ClaimStore", source, ["mode === \"naive\"", "scheduler.wait(100)", "storage.transaction", "transaction.put(\"claimed\", true)"]],
		["Quint", model, ["action readA", "action readB", "action reserveA", "action reserveB", "val atMostOneClaim = accepted <= 1"]],
	]) {
		for (const fragment of required) {
			if (!content.includes(fragment)) throw new Error(`${label}: missing ${fragment}`);
		}
	}
	console.log(`naive: ${naive.map((state) => state.action).join(" → ")}; accepted=${naive.at(-1).accepted}`);
	console.log(`safe: ${safe.map((state) => state.action).join(" → ")}; accepted=${safe.at(-1).accepted}`);
	console.log("claim diagrams: model trace and source mappings verified");
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
