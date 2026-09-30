import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ClaimMode = "naive" | "safe";
type ItfState = {
	accepted: { "#bigint": string };
	phaseA: { "#bigint": string };
	phaseB: { "#bigint": string };
	"mbt::actionTaken": string;
};

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
