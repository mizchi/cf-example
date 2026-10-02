import type { DocumentUpdatedEvent, ProjectionName, ProjectionState, QuarantinedRecord, SearchProjection, SearchRecoveryRequest } from "./event-contract";

export function emptyProjection(name: ProjectionName, subscription: string): ProjectionState {
	return name === "search"
		? { name, subscription, processedEventIds: [], quarantined: [], historyComplete: true, recoveryRequired: false, documents: [] }
		: { name, subscription, processedEventIds: [], quarantined: [], historyComplete: true, recoveryRequired: false, totalUpdates: 0, byDocument: {}, events: [] };
}

export function upgradeProjection(state: ProjectionState): ProjectionState {
	return { ...state, quarantined: state.quarantined ?? [], historyComplete: state.historyComplete ?? true,
		recoveryRequired: state.recoveryRequired ?? false };
}
export function markHistoryGap(state: ProjectionState): ProjectionState {
	return { ...state, historyComplete: false, recoveryRequired: state.name === "search" };
}
export function recoverSearch(current: SearchProjection, subscription: string, documents: SearchProjection["documents"]): SearchProjection {
	const byId = new Map(current.documents.map(document => [document.documentId, document]));
	for (const document of documents) {
		const previous = byId.get(document.documentId);
		if (!previous || previous.version < document.version) byId.set(document.documentId, document);
	}
	return { ...current, subscription, documents: [...byId.values()].sort((a, b) => a.documentId.localeCompare(b.documentId)),
		historyComplete: false, recoveryRequired: false };
}
// Call inside the storage transaction so competing recoveries cannot both win.
export function commitSearchRecovery(current: SearchProjection, request: SearchRecoveryRequest): SearchProjection | null {
	return current.subscription === request.previousSubscription
		? recoverSearch(current, request.subscription, request.documents) : null;
}
export function quarantineRecord(state: ProjectionState, record: QuarantinedRecord): ProjectionState {
	return state.quarantined.some(item => item.id === record.id) ? state : { ...state, quarantined: [...state.quarantined, record] };
}

// Persist the returned state in one transaction: the event marker and effect
// must commit together, including when two workers apply the same event.
export function applyDocumentEvent(state: ProjectionState, event: DocumentUpdatedEvent): ProjectionState {
	if (state.processedEventIds.includes(event.eventId)) return state;
	const processedEventIds = [...state.processedEventIds, event.eventId];
	if (state.name === "audit") {
		const count = Object.hasOwn(state.byDocument, event.documentId) ? state.byDocument[event.documentId] : 0;
		return { ...state, processedEventIds, totalUpdates: state.totalUpdates + 1,
			byDocument: { ...state.byDocument, [event.documentId]: count + 1 }, events: [...state.events, event] };
	}
	const current = state.documents.find(document => document.documentId === event.documentId);
	if (current && current.version >= event.version) return { ...state, processedEventIds };
	const document = { documentId: event.documentId, value: event.value, version: event.version };
	return { ...state, processedEventIds, documents: [...state.documents.filter(item => item.documentId !== event.documentId), document] };
}
