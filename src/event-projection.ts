import type { DocumentUpdatedEvent, ProjectionName, ProjectionState } from "./event-contract";

export function emptyProjection(name: ProjectionName, subscription: string): ProjectionState {
	return name === "search"
		? { name, subscription, processedEventIds: [], documents: [] }
		: { name, subscription, processedEventIds: [], totalUpdates: 0, byDocument: {}, events: [] };
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
