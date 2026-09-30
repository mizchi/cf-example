export interface DocumentSnapshot {
	value: string;
	version: number;
}

export interface WriteResult extends DocumentSnapshot {
	purged: boolean;
}

export function isDocumentSnapshot(value: unknown): value is DocumentSnapshot {
	return typeof value === "object" && value !== null &&
		"value" in value && typeof value.value === "string" &&
		"version" in value && typeof value.version === "number" &&
		Number.isSafeInteger(value.version) && value.version >= 0;
}

export function isWriteResult(value: unknown): value is WriteResult {
	return isDocumentSnapshot(value) && "purged" in value && typeof value.purged === "boolean";
}

export function parseWriteBody(value: unknown): string | null {
	if (typeof value !== "object" || value === null || !("value" in value)) return null;
	return typeof value.value === "string" && value.value.length <= 1000 ? value.value : null;
}

export function acceptSnapshot(current: DocumentSnapshot | null, incoming: DocumentSnapshot): DocumentSnapshot {
	return current === null || incoming.version > current.version ? incoming : current;
}
