// A deliberately small local substitute: one active batch per subscription,
// retained records, and the documented K2 HTTP response shapes.
export interface StreamRecord {
	content: string;
	headers?: Record<string, string>;
	timestamp_ms: number;
}
export interface StreamLease {
	id: string;
	workerId: string;
	until: number;
	end: number;
	records: StreamRecord[];
}
export interface StreamSubscription {
	id: string;
	name: string;
	cursor: number;
	lease: StreamLease | null;
}
export interface LocalStreamState {
	records: StreamRecord[];
	subscriptions: StreamSubscription[];
}
export const LEASE_MS = 5 * 60 * 1000;

export function leaseRecords(state: LocalStreamState, subscription: StreamSubscription,
	workerId: string, maxRecords: number, now: number, batchId: string): StreamLease | null | "busy" {
	const current = subscription.lease;
	if (current && current.until > now) {
		if (current.workerId !== workerId) return "busy";
		return { ...current, until: now + LEASE_MS };
	}
	const records = state.records.slice(subscription.cursor, subscription.cursor + maxRecords);
	return records.length === 0 ? null : { id: batchId, workerId, until: now + LEASE_MS,
		end: subscription.cursor + records.length, records };
}
