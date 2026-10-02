import { isDocumentUpdatedEvent, isObject, type DocumentUpdatedEvent } from "./event-contract";

export type K2Request = (path: string, body: unknown) => Promise<Response>;
export interface ConsumedRecord { content: string; timestamp_ms: number }
export interface LeasedEventBatch {
	subscriptionId: string;
	batchId: string;
	leasedUntil: number;
	records: ConsumedRecord[];
}

export class K2RequestError extends Error {
	constructor(readonly status: number, readonly retryable: boolean, readonly code?: number) {
		super(`K2 request failed: HTTP ${status}${code === undefined ? "" : `, code ${code}`}`);
	}
}

export function encodeEvent(event: DocumentUpdatedEvent): string {
	const bytes = new TextEncoder().encode(JSON.stringify(event));
	return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
}
export function decodeEvent(content: string): DocumentUpdatedEvent {
	const bytes = Uint8Array.from(atob(content), character => character.charCodeAt(0));
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	if (!isDocumentUpdatedEvent(value)) throw new Error("Invalid document.updated record");
	return value;
}

// The same HTTP contract drives the real K2 endpoint and the local DO.
// A network/unknown append failure never discards the caller's outbox.
export class K2Client {
	constructor(private readonly request: K2Request) {}

	private async call(path: string, body: unknown): Promise<Record<string, unknown>> {
		const response = await this.request(path, body);
		const value: unknown = await response.json().catch(() => null);
		if (!response.ok || !isObject(value) || value.success !== true) {
			const error = isObject(value) && isObject(value.error) ? value.error : null;
			const apiError = isObject(value) && Array.isArray(value.errors) && isObject(value.errors[0]) ? value.errors[0] : null;
			const code = typeof error?.code === "number" ? error.code : typeof apiError?.code === "number" ? apiError.code : undefined;
			throw new K2RequestError(response.status, error ? error.retryable === true :
				code !== undefined && [10211, 10214, 10216, 10217].includes(code), code);
		}
		return value;
	}

	async produce(events: DocumentUpdatedEvent[]): Promise<void> {
		if (events.length === 0) return;
		await this.call("/produce", { records: events.map(event => ({ content: encodeEvent(event), headers: { "content-type": "application/json" } })) });
	}

	async ensureSubscription(subscription: string, start: "earliest" | "latest" = "earliest"): Promise<string> {
		const created = await this.call("/subscriptions", { name: subscription, start_at: { type: start } });
		if (!isObject(created.result) || typeof created.result.id !== "string") throw new Error("Invalid K2 subscription response");
		return created.result.id;
	}
	async consume(subscription: string, workerId: string): Promise<LeasedEventBatch | null> {
		const subscriptionId = await this.ensureSubscription(subscription);
		const response = await this.call(`/subscriptions/${encodeURIComponent(subscriptionId)}/consume`, { worker_id: workerId, max_records: 100 });
		if (!isObject(response.result)) throw new Error("Invalid K2 consume response");
		const result = response.result;
		if (!Array.isArray(result.records)) throw new Error("Invalid K2 consume records");
		if (result.records.length === 0 && result.batch_id === null && result.leased_until_ms === null) return null;
		if (result.records.length === 0 || typeof result.batch_id !== "string" || !result.batch_id ||
			typeof result.leased_until_ms !== "number" || !Number.isSafeInteger(result.leased_until_ms) || result.leased_until_ms < 0) throw new Error("Invalid K2 lease");
		const records = result.records.map(record => {
			if (!isObject(record) || typeof record.content !== "string" || typeof record.timestamp_ms !== "number" ||
				!Number.isSafeInteger(record.timestamp_ms) || record.timestamp_ms < 0) throw new Error("Invalid K2 record envelope");
			return { content: record.content, timestamp_ms: record.timestamp_ms };
		});
		return { subscriptionId, batchId: result.batch_id, leasedUntil: result.leased_until_ms, records };
	}

	async ack(batch: LeasedEventBatch, workerId: string): Promise<void> {
		await this.call(`/subscriptions/${encodeURIComponent(batch.subscriptionId)}/batches/${encodeURIComponent(batch.batchId)}/ack`, { worker_id: workerId });
	}
}
