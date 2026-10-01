import { isDocumentSnapshot, type DocumentSnapshot } from "./document-contract";

export type ProjectionName = "search" | "audit";
export type PublishFault = "none" | "before-send" | "after-send";
export type ConsumerFault = "none" | "after-first-effect" | "before-ack";

export interface DocumentUpdatedEvent extends DocumentSnapshot {
	type: "document.updated";
	schemaVersion: 1;
	eventId: string;
	projectId: string;
	documentId: string;
	occurredAt: number;
}

export interface EventDocumentView {
	document: DocumentSnapshot;
	pending: DocumentUpdatedEvent[];
}

interface ProjectionBase {
	subscription: string;
	processedEventIds: string[];
}
export interface SearchProjection extends ProjectionBase {
	name: "search";
	documents: (DocumentSnapshot & { documentId: string })[];
}
export interface AuditProjection extends ProjectionBase {
	name: "audit";
	totalUpdates: number;
	byDocument: Record<string, number>;
	events: DocumentUpdatedEvent[];
}
export type ProjectionState = SearchProjection | AuditProjection;
export interface PipelineView {
	transport: "local" | "remote";
	search: SearchProjection;
	audit: AuditProjection;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(value);
}
export function eventId(projectId: string, documentId: string, version: number): string {
	return `${projectId}:${documentId}:${version}`;
}
export function isDocumentUpdatedEvent(value: unknown): value is DocumentUpdatedEvent {
	return isObject(value) && isDocumentSnapshot(value) && value.version > 0 && value.value.length <= 1000 &&
		value.type === "document.updated" && value.schemaVersion === 1 &&
		isIdentifier(value.projectId) && isIdentifier(value.documentId) &&
		value.eventId === eventId(value.projectId, value.documentId, value.version) &&
		typeof value.occurredAt === "number" && Number.isSafeInteger(value.occurredAt) && value.occurredAt >= 0;
}
export function isEventDocumentView(value: unknown): value is EventDocumentView {
	return isObject(value) && isDocumentSnapshot(value.document) && Array.isArray(value.pending) && value.pending.every(isDocumentUpdatedEvent);
}
export function isProjectionState(value: unknown): value is ProjectionState {
	if (!isObject(value) || typeof value.subscription !== "string" || !Array.isArray(value.processedEventIds) ||
		!value.processedEventIds.every(id => typeof id === "string")) return false;
	if (value.name === "search") return Array.isArray(value.documents) && value.documents.every(document =>
		isObject(document) && isDocumentSnapshot(document) && isIdentifier(document.documentId));
	return value.name === "audit" && typeof value.totalUpdates === "number" && Number.isSafeInteger(value.totalUpdates) && value.totalUpdates >= 0 &&
		isObject(value.byDocument) && Object.values(value.byDocument).every(count => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) &&
		Array.isArray(value.events) && value.events.every(isDocumentUpdatedEvent);
}
export function isPipelineView(value: unknown): value is PipelineView {
	return isObject(value) && (value.transport === "local" || value.transport === "remote") &&
		isProjectionState(value.search) && value.search.name === "search" && isProjectionState(value.audit) && value.audit.name === "audit";
}

export function isPublishFault(value: unknown): value is PublishFault {
	return value === "none" || value === "before-send" || value === "after-send";
}
export function isConsumerFault(value: unknown): value is ConsumerFault {
	return value === "none" || value === "after-first-effect" || value === "before-ack";
}
