import { DurableObject } from "cloudflare:workers";
import { isObject } from "./event-contract";
import { LEASE_MS, leaseRecords, type LocalStreamState, type StreamRecord } from "./local-stream-state";

const ok = (result: unknown = {}) => Response.json({ success: true, result, errors: [], messages: [] });

export class LocalK2Stream extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		const invalid = (message: string, status = 400) => {
			const code = status === 404 ? 10215 : status === 429 ? 10216 : status === 409 ? 10218 : 10204;
			return Response.json(path === "/produce" ? { success: false, error: { code, message, retryable: false } }
				: { success: false, result: null, errors: [{ code, message }], messages: [] }, { status });
		};
		if (request.method !== "POST") return invalid("Method not allowed", 405);
		const body: unknown = await request.json().catch(() => null);
		if (!isObject(body)) return invalid("Invalid JSON body");
		return this.ctx.storage.transaction(async transaction => {
			const state = await transaction.get<LocalStreamState>("stream") ?? { records: [], subscriptions: [] };
			let response: Response;
			if (path === "/expire") {
				const expired = state.records.length;
				state.base = (state.base ?? 0) + expired;
				state.records = [];
				for (const subscription of state.subscriptions) subscription.lease = null;
				response = ok({ expired });
			} else if (path === "/history") {
				if (typeof body.name !== "string" || (body.resume !== undefined && typeof body.resume !== "boolean")) return invalid("Invalid history probe");
				const subscription = state.subscriptions.find(item => item.name.toLowerCase() === (body.name as string).toLowerCase());
				const base = state.base ?? 0;
				const gap = base > 0 && (!subscription || subscription.cursor < base);
				if (gap && subscription && body.resume === true) subscription.cursor = base;
				response = ok({ gap });
			} else if (path === "/produce") {
				if (!Array.isArray(body.records) || body.records.length === 0 || body.records.length > 10000) return invalid("Invalid records");
				const records: StreamRecord[] = [];
				for (const record of body.records) {
					if (!isObject(record) || typeof record.content !== "string" ||
						(record.headers !== undefined && (!isObject(record.headers) || !Object.values(record.headers).every(value => typeof value === "string")))) return invalid("Invalid record");
					try { atob(record.content); } catch { return invalid("Invalid base64 content"); }
					records.push({ content: record.content, timestamp_ms: Date.now(),
						...(record.headers === undefined ? {} : { headers: record.headers as Record<string, string> }) });
				}
				state.records.push(...records);
				response = Response.json({ success: true });
			} else if (path === "/subscriptions") {
				if (typeof body.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.name) ||
					!isObject(body.start_at) || (body.start_at.type !== "earliest" && body.start_at.type !== "latest")) return invalid("Invalid subscription start");
				const name = body.name;
				let subscription = state.subscriptions.find(item => item.name.toLowerCase() === name.toLowerCase());
				if (!subscription) {
					subscription = { id: crypto.randomUUID(), name: body.name,
						cursor: (state.base ?? 0) + (body.start_at.type === "latest" ? state.records.length : 0), lease: null };
					state.subscriptions.push(subscription);
				}
				response = ok({ id: subscription.id });
			} else {
				const consume = /^\/subscriptions\/([^/]+)\/consume$/.exec(path);
				const batch = /^\/subscriptions\/([^/]+)\/batches\/([^/]+)\/(ack|nack|extend)$/.exec(path);
				const subscriptionId = consume?.[1] ?? batch?.[1];
				const subscription = state.subscriptions.find(item => item.id === subscriptionId);
				if (!subscription) return invalid("Subscription not found", 404);
				if (typeof body.worker_id !== "string" || body.worker_id.length === 0 || body.worker_id.length > 256) return invalid("Invalid worker_id");
				if (consume) {
					const maxRecords = body.max_records ?? 100;
					if (typeof maxRecords !== "number" || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000) return invalid("Invalid max_records");
					const lease = leaseRecords(state, subscription, body.worker_id, maxRecords, Date.now(), crypto.randomUUID());
					if (lease === "busy") return invalid("Local subscription has an active lease", 429);
					if (lease === "history-gap") return invalid("Local subscription requires history recovery", 409);
					subscription.lease = lease;
					response = ok({ batch_id: lease?.id ?? null, leased_until_ms: lease?.until ?? null, records: lease?.records ?? [] });
				} else if (batch) {
					const lease = subscription.lease;
					const matches = lease?.id === batch[2];
					if (batch[3] === "extend") {
						if (!matches || !lease || lease.workerId !== body.worker_id || lease.until <= Date.now()) return invalid("Invalid or expired lease", 409);
						lease.until = Date.now() + LEASE_MS;
						response = ok({ leased_until_ms: lease.until });
					} else {
						// A superseded or already-acked batch is a successful no-op.
						if (matches && lease) {
							if (batch[3] === "ack") subscription.cursor = lease.end;
							subscription.lease = null;
						}
						response = ok();
					}
				} else return invalid("Not found", 404);
			}
			await transaction.put("stream", state);
			return response;
		});
	}
}
