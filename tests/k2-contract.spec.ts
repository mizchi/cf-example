import { expect, test } from "@playwright/test";
import { K2Client, K2RequestError } from "../src/k2-client";
import type { DocumentUpdatedEvent } from "../src/event-contract";
import { LEASE_MS, leaseRecords, type LocalStreamState } from "../src/local-stream-state";

const event: DocumentUpdatedEvent = { type: "document.updated", schemaVersion: 1, eventId: "project:article:1",
	projectId: "project", documentId: "article", version: 1, value: "日本語 🌸", occurredAt: 1790164800000 };
const content = Buffer.from(JSON.stringify(event), "utf8").toString("base64");

test("K2 HTTP 契約: UTF-8 の produce と subscription/consume/ack", async () => {
	const calls: { path: string; body: unknown }[] = [];
	const client = new K2Client(async (path, body) => {
		calls.push({ path, body });
		if (path === "/produce") return Response.json({ success: true });
		if (path === "/subscriptions") return Response.json({ success: true, result: { id: "subscription-1" }, errors: [], messages: [] });
		if (path.endsWith("/consume")) return Response.json({ success: true, result: { batch_id: "batch-1",
			leased_until_ms: 1790165100000, records: [{ timestamp_ms: 1790164800000, content }] } });
		if (path.endsWith("/ack")) return Response.json({ success: true, result: {}, errors: [], messages: [] });
		throw new Error(`Unexpected path ${path}`);
	});
	await client.produce([event]);
	const batch = await client.consume("search", "worker-1");
	expect(batch).toEqual({ subscriptionId: "subscription-1", batchId: "batch-1", leasedUntil: 1790165100000, records: [{ content, timestamp_ms: 1790164800000 }] });
	await client.ack(batch!, "worker-1");
	expect(calls).toEqual([
		{ path: "/produce", body: { records: [{ content, headers: { "content-type": "application/json" } }] } },
		{ path: "/subscriptions", body: { name: "search", start_at: { type: "earliest" } } },
		{ path: "/subscriptions/subscription-1/consume", body: { worker_id: "worker-1", max_records: 100 } },
		{ path: "/subscriptions/subscription-1/batches/batch-1/ack", body: { worker_id: "worker-1" } },
	]);
});

test("K2 の失敗フラグ・結果不明・consume の一時エラーを区別する", async () => {
	for (const [status, code, retryable] of [[200, 10211, true], [503, 10212, false]] as const) {
		const client = new K2Client(async () => Response.json({ success: false, error: { code, message: "failure", retryable } }, { status }));
		await expect(client.produce([event])).rejects.toMatchObject({ status, code, retryable });
	}
	const client = new K2Client(async () => Response.json({ success: false, result: null, errors: [{ code: 10216, message: "busy" }] }, { status: 429 }));
	await expect(client.consume("search", "worker-1")).rejects.toBeInstanceOf(K2RequestError);
	await expect(client.consume("search", "worker-1")).rejects.toMatchObject({ retryable: true, code: 10216 });
});

test("空 batch は ack せず、不正な HTTP record envelope も成功扱いしない", async () => {
	let invalid = false;
	const paths: string[] = [];
	const client = new K2Client(async path => {
		paths.push(path);
		if (path === "/subscriptions") return Response.json({ success: true, result: { id: "sub" } });
		return Response.json({ success: true, result: invalid
			? { batch_id: "batch", leased_until_ms: 1790165100000, records: [{ content: Buffer.from('{"value":"bad"}').toString("base64") }] }
			: { batch_id: null, leased_until_ms: null, records: [] } });
	});
	expect(await client.consume("search", "worker")).toBeNull();
	invalid = true;
	await expect(client.consume("search", "worker")).rejects.toThrow("Invalid K2 record envelope");
	expect(paths.some(path => path.endsWith("/ack"))).toBe(false);
});

test("ローカル lease は同じ worker に同じ batch を返し、期限切れ後は新世代になる", () => {
	const state: LocalStreamState = { records: [{ content, timestamp_ms: 100 }], subscriptions: [] };
	const subscription = { id: "sub", name: "search", cursor: 0, lease: null };
	const first = leaseRecords(state, subscription, "worker-1", 1, 100, "batch-1");
	if (!first || first === "busy") throw new Error("Expected lease");
	const leased = { ...subscription, lease: first };
	state.records.push({ content, timestamp_ms: 200 });
	expect(leaseRecords(state, leased, "worker-1", 100, 200, "ignored")).toEqual({ ...first, until: 200 + LEASE_MS });
	expect(leaseRecords(state, leased, "worker-2", 100, 200, "batch-2")).toBe("busy");
	const redelivered = leaseRecords(state, leased, "worker-2", 1, first.until, "batch-2");
	expect(redelivered).toMatchObject({ id: "batch-2", workerId: "worker-2", records: first.records });
	expect(state.records).toHaveLength(2);
});
