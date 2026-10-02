import type { DocumentUpdatedEvent, QuarantinedRecord } from "./event-contract";
import { decodeEvent, type ConsumedRecord } from "./k2-client";

export async function classifyRecord(record: ConsumedRecord): Promise<
	{ event: DocumentUpdatedEvent; quarantine?: never } | { event?: never; quarantine: QuarantinedRecord }
> {
	try { return { event: decodeEvent(record.content) }; }
	catch (error) {
		// Record identity survives redelivery and changing lease/batch IDs.
		// Identical bytes at the same timestamp share one quarantine copy.
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(record)));
		const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
		return { quarantine: { ...record, id, reason: error instanceof Error ? error.message : "Invalid event" } };
	}
}
