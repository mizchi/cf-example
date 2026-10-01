import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const env = { ...process.env };
if (!env.JAVA_HOME && spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
	const brew = spawnSync("brew", ["--prefix", "openjdk"], { encoding: "utf8" });
	if (brew.status === 0) {
		const prefix = brew.stdout.trim();
		const home = join(prefix, "libexec/openjdk.jdk/Contents/Home");
		if (existsSync(join(home, "bin/java"))) {
			env.JAVA_HOME = home;
			env.PATH = `${join(home, "bin")}:${env.PATH}`;
		}
	}
}

function verify({ file, main, step, invariants }) {
	const result = spawnSync("pnpm", ["exec", "quint", "verify", file, "--main", main, "--backend", "tlc", "--step", step, "--invariants", ...invariants], {
		encoding: "utf8",
		env,
		maxBuffer: 10 * 1024 * 1024,
	});
	return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

const models = [
	{ name: "Workers Cache sync", file: "models/sync.qnt", main: "sync", invariants: ["monotonicClient", "cacheNeverAhead"] },
	{ name: "Durable Object claim", file: "models/durable-object.qnt", main: "durableObject", invariants: ["atMostOneClaim"] },
	{ name: "D1 replica read", file: "models/d1.qnt", main: "d1", invariants: ["readMyWrites"] },
	{ name: "R2 conditional put", file: "models/r2.qnt", main: "r2", invariants: ["noStaleOverwrite"] },
	{ name: "waitUntil background", file: "models/wait-until.qnt", main: "waitUntil", invariants: ["noLostAccepted"], sanityInvariant: "noCompletedAccepted", witness: ["start", "respondNaive", "cancelOrReject"] },
	{ name: "Queues idempotency", file: "models/queues.qnt", main: "queues", invariants: ["atMostOneEffect", "queueWellFormed"], sanityInvariant: "noRetryHandled", witness: ["send", "deliver", "applyNaive", "failAfterEffect", "deliver", "applyNaive"] },
	{ name: "Queues consumer batch", file: "models/queue-consumer.qnt", main: "queueConsumer", invariants: ["noAckBeforeEffect", "noLostB", "queueWellFormed"], sanityInvariant: "noCompletedBatch", witness: ["sendBatch", "deliverBatch", "processA", "failB", "catchAndReturnNaive"] },
	{
		name: "K2 batch consumer", file: "models/k2.qnt", main: "k2",
		invariants: ["atMostOneEffect", "noAckBeforeEffects", "streamWellFormed", "subscriptionIsolation", "staleAckCannotAdvance", "recoveryKeepsBatch", "extensionKeepsLease"],
		counterexamples: [{ step: "stepAckEarly", invariants: ["noAckBeforeEffects"], label: "early ack" }],
		sanityChecks: [
			{ invariant: "noReplayCompleted", label: "replay completion" },
			{ invariant: "noFanoutCompleted", label: "independent subscriptions" },
			{ invariant: "noStaleAckIgnored", label: "stale ack ignored" },
			{ invariant: "noLeaseRecovery", label: "lease recovery" },
			{ invariant: "noLeaseExtension", label: "lease extension" },
		],
	},
	{
		name: "Document event pipeline", file: "models/document-events.qnt", main: "documentEvents",
		invariants: ["noLostSaved", "monotonicSearch", "atMostOneAudit", "readModelsNeverAhead", "auditConsistent"],
		counterexamples: [
			{ step: "stepStale", invariants: ["monotonicSearch"], label: "stale version" },
			{ step: "stepDuplicate", invariants: ["atMostOneAudit"], label: "duplicate effect" },
		],
		sanityChecks: [
			{ invariant: "noCaughtUp", label: "independent sinks caught up" },
			{ invariant: "noRetriedPublicationCompletes", label: "publication retry completion" },
		],
	},
];

const selected = process.argv.slice(2);
if (selected.some((name) => !models.some((model) => model.main === name))) {
	throw new Error(`Unknown model: ${selected.join(", ")}`);
}

for (const model of models.filter((model) => selected.length === 0 || selected.includes(model.main))) {
	const variants = [{ step: "stepNaive", invariants: model.invariants.slice(0, 1), witness: model.witness, label: "naive" }, ...(model.counterexamples ?? [])];
	for (const variant of variants) {
		const broken = verify({ ...model, ...variant });
		if (broken.status !== 1 || !broken.output.includes("found a counterexample")) {
			console.error(broken.output);
			throw new Error(`${model.name}: expected a ${variant.label} counterexample`);
		}
		if (variant.witness) {
			const actions = [...broken.output.matchAll(/^State \d+: <([A-Za-z]+) line/gm)].map((match) => match[1]);
			if (actions.join() !== variant.witness.join()) {
				throw new Error(`${model.name}: unexpected TLC witness ${actions.join(" → ")}`);
			}
		}
		console.log(`${model.name}: ${variant.label} counterexample found.`);
	}

	const repaired = verify({ ...model, step: "stepSafe" });
	if (repaired.status !== 0) {
		console.error(repaired.output);
		throw new Error(`${model.name}: repaired model violates an invariant`);
	}
	console.log(`${model.name}: repaired invariants hold.`);

	const sanityChecks = [...(model.sanityInvariant ? [{ invariant: model.sanityInvariant, label: "safe progress" }] : []), ...(model.sanityChecks ?? [])];
	for (const check of sanityChecks) {
		const witness = verify({ ...model, step: "stepSafe", invariants: [check.invariant] });
		if (witness.status !== 1 || !witness.output.includes("found a counterexample")) {
			console.error(witness.output);
			throw new Error(`${model.name}: ${check.label} witness was not reachable`);
		}
		console.log(`${model.name}: ${check.label} witness found.`);
	}
}
