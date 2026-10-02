import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ClaimMode = "naive" | "safe";

function decodeItf(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(decodeItf);
	if (typeof value !== "object" || value === null) return value;
	if ("#bigint" in value) {
		const integer = Number(value["#bigint"]);
		if (!Number.isSafeInteger(integer)) throw new Error("ITF integer is out of range");
		return integer;
	}
	if ("#set" in value) return decodeItf(value["#set"]);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeItf(item)]));
}

export function recoveryPatternOracle(name: "saveRequest" | "poisonEvents" | "retentionRecovery"): { final: Record<string, unknown>; actions: string[]; states: Record<string, unknown>[] } {
	const models = {
		saveRequest: ["models/save-request.qnt", "noRetriedResponse"],
		poisonEvents: ["models/poison-events.qnt", "noRecoveredBatch"],
		retentionRecovery: ["models/retention-recovery.qnt", "noRecoveredWithConcurrentWrite"],
	};
	const [file, invariant] = models[name];
	const directory = mkdtempSync(join(tmpdir(), "cf-recovery-pattern-"));
	try {
		const output = join(directory, "trace.itf.json");
		const result = spawnSync("pnpm", ["exec", "quint", "run", file, "--main", name, "--step", "stepSafe",
			"--invariant", invariant, "--seed", "7", "--max-steps", "50", "--max-samples", "500", "--out-itf", output, "--mbt", "--backend", "typescript"], { encoding: "utf8" });
		if (result.status !== 1 || !result.stdout.includes("[violation]")) throw new Error(`No progress witness: ${result.stdout}\n${result.stderr}`);
		const trace = JSON.parse(readFileSync(output, "utf8")) as { states: Record<string, unknown>[] };
		const states = trace.states.map(state => decodeItf(state) as Record<string, unknown>);
		const last = states.at(-1);
		if (!last) throw new Error("Empty recovery witness");
		return { final: last, actions: states.slice(1).map(state => String(state["mbt::actionTaken"])), states };
	} finally { rmSync(directory, { recursive: true, force: true }); }
}
type ItfState = {
	accepted: { "#bigint": string };
	phaseA: { "#bigint": string };
	phaseB: { "#bigint": string };
	"mbt::actionTaken": string;
};

export function documentEventOracle(): { documentVersion: number; searchVersion: number; auditCount: number; actions: string[] } {
	const directory = mkdtempSync(join(tmpdir(), "cf-document-events-"));
	const output = join(directory, "events.itf.json");
	try {
		const result = spawnSync("pnpm", ["exec", "quint", "run", "models/document-events.qnt", "--main", "documentEvents",
			"--step", "stepSafe", "--invariant", "noCaughtUp", "--max-steps", "30", "--max-samples", "100", "--seed", "7",
			"--out-itf", output, "--mbt", "--backend", "typescript"], { encoding: "utf8" });
		// noCaughtUp is a negated reachability property: a violation is the
		// positive terminal witness used here, not a safety failure.
		if (result.status !== 1 || !result.stdout.includes("[violation]")) throw new Error(`Quint failed: ${result.stdout}\n${result.stderr}`);
		const trace = JSON.parse(readFileSync(output, "utf8")) as { states: {
			documentVersion: { "#bigint": string }; searchVersion: { "#bigint": string }; auditCount: { "#bigint": string };
			"mbt::actionTaken": string;
		}[] };
		const last = trace.states.at(-1);
		if (!last) throw new Error("Quint returned an empty trace");
		return { documentVersion: Number(last.documentVersion["#bigint"]), searchVersion: Number(last.searchVersion["#bigint"]),
			auditCount: Number(last.auditCount["#bigint"]), actions: trace.states.slice(1).map(state => state["mbt::actionTaken"]) };
	} finally { rmSync(directory, { recursive: true, force: true }); }
}

export function claimOracle(mode: ClaimMode): { accepted: number; actions: string[] } {
	const directory = mkdtempSync(join(tmpdir(), "cf-example-quint-"));
	const output = join(directory, "claim.itf.json");
	try {
		const result = spawnSync("pnpm", [
			"exec", "quint", "run", "models/durable-object.qnt",
			"--main", "durableObject",
			"--step", mode === "safe" ? "stepSafe" : "stepNaive",
			"--invariant", "atMostOneClaim",
			"--max-steps", "4",
			"--max-samples", "100",
			"--seed", "7",
			"--out-itf", output,
			"--mbt",
			"--backend", "typescript",
		], { encoding: "utf8" });
		if (result.status !== (mode === "safe" ? 0 : 1)) {
			throw new Error(`Quint failed: ${result.stdout}\n${result.stderr}`);
		}
		const trace = JSON.parse(readFileSync(output, "utf8")) as { states: ItfState[] };
		const last = trace.states.at(-1);
		if (!last) throw new Error("Quint returned an empty trace");
		const phases = [Number(last.phaseA["#bigint"]), Number(last.phaseB["#bigint"])].sort();
		const expectedPhases = mode === "safe" ? [2, 3] : [2, 2];
		if (phases.join() !== expectedPhases.join()) throw new Error(`Unexpected terminal phases: ${phases}`);
		return {
			accepted: Number(last.accepted["#bigint"]),
			actions: trace.states.slice(1).map((state) => state["mbt::actionTaken"]),
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
