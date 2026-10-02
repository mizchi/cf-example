import { expect, test } from "@playwright/test";
import type { AuditProjection, DocumentUpdatedEvent, SearchProjection, SearchRecoveryRequest } from "../src/event-contract";
import { applyDocumentEvent, commitSearchRecovery, emptyProjection, markHistoryGap } from "../src/event-projection";
import { decodeEvent, encodeEvent } from "../src/k2-client";
import { leaseRecords, type LocalStreamState, type StreamSubscription } from "../src/local-stream-state";
import { recoverSearchProjection } from "../src/search-recovery";
import { recoveryPatternOracle } from "./quint-oracle";

function initialSearch(): SearchProjection {
	const state = emptyProjection("search", "old");
	if (state.name !== "search") throw new Error("Expected search projection");
	return state;
}
function initialAudit(): AuditProjection {
	const state = emptyProjection("audit", "audit");
	if (state.name !== "audit") throw new Error("Expected audit projection");
	return state;
}
function update(version: number): DocumentUpdatedEvent {
	return { type: "document.updated", schemaVersion: 1, projectId: "project", documentId: "article",
		eventId: `project:article:${version}`, version, value: `v${version}`, occurredAt: version };
}
function documents(version: number): SearchProjection["documents"] {
	return version ? [{ documentId: "article", version, value: `v${version}` }] : [];
}

test("Quint の復旧 ITF を全操作再生し、各段階の検索と監査を実装と照合する", async () => {
	const oracle = recoveryPatternOracle("retentionRecovery");
	const stream: LocalStreamState = { base: 0, records: [], subscriptions: [] };
	const auditSubscription: StreamSubscription = { id: "audit", name: "audit", cursor: 0, lease: null };
	let search = initialSearch();
	let audit = initialAudit();
	let source = 0;
	let searchCursor = 0;
	let latestCursor = 0;
	let snapshotVersion = 0;
	let recovery: Promise<Response> | undefined;
	const latest = Promise.withResolvers<string>();
	const snapshot = Promise.withResolvers<SearchProjection["documents"]>();
	const committed = Promise.withResolvers<Response>();
	const latestEntered = Promise.withResolvers<"latest">();
	const snapshotEntered = Promise.withResolvers<"snapshot">();
	const commitEntered = Promise.withResolvers<SearchRecoveryRequest>();
	const consumeOne = (subscription: StreamSubscription): DocumentUpdatedEvent => {
		const lease = leaseRecords(stream, subscription, "worker", 1, 100, "batch");
		if (!lease || typeof lease === "string") throw new Error(`Expected record, got ${lease}`);
		subscription.cursor = lease.end;
		return decodeEvent(lease.records[0].content);
	};

	for (const state of oracle.states) {
		const action = state["mbt::actionTaken"];
		switch (action) {
			case "init": break;
			case "produce": {
				source++;
				stream.records.push({ content: encodeEvent(update(source)), timestamp_ms: source });
				break;
			}
			case "expire":
				stream.base = (stream.base ?? 0) + stream.records.length;
				stream.records = [];
				break;
			case "resumeAuditSafe":
				audit = markHistoryGap(audit) as AuditProjection;
				auditSubscription.cursor = stream.base ?? 0;
				break;
			case "consumeAudit":
				audit = applyDocumentEvent(audit, consumeOne(auditSubscription)) as AuditProjection;
				break;
			case "beginSafe":
				recovery = recoverSearchProjection(search.subscription, {
					createLatestSubscription: () => { latestEntered.resolve("latest"); return latest.promise; },
					readDocuments: () => { snapshotEntered.resolve("snapshot"); return snapshot.promise; },
					commit: request => { commitEntered.resolve(request); return committed.promise; },
				});
				// This assertion fails for the snapshot-first broken variant.
				expect(await Promise.race([latestEntered.promise, snapshotEntered.promise])).toBe("latest");
				latestCursor = source;
				latest.resolve("new");
				await snapshotEntered.promise;
				break;
			case "secondSafe":
				snapshotVersion = source;
				snapshot.resolve(documents(source));
				await commitEntered.promise;
				break;
			case "commit": {
				const next = commitSearchRecovery(search, await commitEntered.promise);
				if (!next) throw new Error("Unexpected generation conflict");
				search = next;
				searchCursor = latestCursor;
				committed.resolve(Response.json(search));
				expect((await recovery!).ok).toBe(true);
				break;
			}
			case "consumeSearch": {
				const subscription: StreamSubscription = { id: "new", name: "new", cursor: searchCursor, lease: null };
				search = applyDocumentEvent(search, consumeOne(subscription)) as SearchProjection;
				searchCursor = subscription.cursor;
				break;
			}
			case "settle":
				expect(leaseRecords(stream, { id: "new", name: "new", cursor: searchCursor, lease: null }, "worker", 1, 100, "batch")).toBeNull();
				expect(search.documents[0]?.version ?? 0).toBe(source);
				break;
			default: throw new Error(`Unsupported ITF action: ${action}`);
		}
		expect({
			source, expiredThrough: stream.base ?? 0, retained: stream.records.map(record => decodeEvent(record.content).version),
			search: search.documents[0]?.version ?? 0, cursor: searchCursor,
			subscriptionStart: latestCursor, snapshot: snapshotVersion,
			auditCursor: auditSubscription.cursor, auditSeen: audit.events.map(event => event.version), auditComplete: audit.historyComplete,
		}, String(action)).toEqual(Object.fromEntries(["source", "expiredThrough", "retained", "search", "cursor", "subscriptionStart", "snapshot", "auditCursor", "auditSeen", "auditComplete"].map(key => [key, state[key]])));
	}
});

for (const point of ["before-subscribe", "before-snapshot", "after-snapshot"] as const) {
	test(`復旧中の更新を取り逃さない: ${point}`, async () => {
		let source = 2;
		let cursor = 0;
		let search = initialSearch();
		const response = await recoverSearchProjection("old", {
			createLatestSubscription: async () => {
				if (point === "before-subscribe") source = 3;
				cursor = source;
				if (point === "before-snapshot") source = 3;
				return "new";
			},
			readDocuments: async () => {
				const snapshot = documents(source);
				if (point === "after-snapshot") source = 3;
				return snapshot;
			},
			commit: async request => {
				const next = commitSearchRecovery(search, request);
				if (!next) throw new Error("Unexpected conflict");
				search = next;
				return Response.json(next);
			},
		});
		expect(response.ok).toBe(true);
		// Replay all writes after creation of the latest reader.
		while (cursor < source) search = applyDocumentEvent(search, update(++cursor)) as SearchProjection;
		expect(search.documents).toEqual(documents(3));
	});
}

for (const failure of ["subscription", "snapshot"] as const) {
	test(`復旧の ${failure} 失敗時には現在世代を切り替えない`, async () => {
		const search = initialSearch();
		const calls: string[] = [];
		await expect(recoverSearchProjection(search.subscription, {
			createLatestSubscription: async () => {
				calls.push("subscription");
				if (failure === "subscription") throw new Error("Unavailable");
				return "new";
			},
			readDocuments: async () => { calls.push("snapshot"); throw new Error("Unavailable"); },
			commit: async () => { calls.push("commit"); throw new Error("Must not commit"); },
		})).rejects.toThrow("Unavailable");
		expect(calls).toEqual(failure === "subscription" ? ["subscription"] : ["subscription", "snapshot"]);
		expect(search.subscription).toBe("old");
	});
}

test("競合した復旧は先に切り替えた世代だけ成功し、遅い旧世代は上書きできない", async () => {
	let search = initialSearch();
	const pending = Promise.withResolvers<SearchProjection["documents"]>();
	const entered = Promise.withResolvers<void>();
	const commit = async (request: SearchRecoveryRequest): Promise<Response> => {
		const next = commitSearchRecovery(search, request);
		if (!next) return new Response("Projection was reset", { status: 409 });
		search = next;
		return Response.json(next);
	};
	const slow = recoverSearchProjection("old", {
		createLatestSubscription: async () => "slow",
		readDocuments: () => { entered.resolve(); return pending.promise; },
		commit,
	});
	await entered.promise;
	const fast = await recoverSearchProjection("old", {
		createLatestSubscription: async () => "fast", readDocuments: async () => documents(3), commit,
	});
	pending.resolve(documents(2));
	expect(fast.status).toBe(200);
	expect((await slow).status).toBe(409);
	expect(search.subscription).toBe("fast");
	expect(search.documents).toEqual(documents(3));
});
