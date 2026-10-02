import { isDocumentSnapshot, type DocumentSnapshot } from "./document-contract";

export type ProjectionName = "search" | "audit";
export type PublishFault = "none" | "before-send" | "after-send";
export type ConsumerFault = "none" | "after-first-effect" | "before-ack" | "before-quarantine";
export interface EventWriteRequest { value: string; requestId?: string; fault: "none" | "after-save" }
export interface QuarantinedRecord { id: string; content: string; timestamp_ms: number; reason: string }

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
	quarantined: QuarantinedRecord[];
	historyComplete: boolean;
	recoveryRequired: boolean;
}
export interface SearchProjection extends ProjectionBase {
	name: "search";
	documents: (DocumentSnapshot & { documentId: string })[];
}
export interface SearchRecoveryRequest {
	subscription: string;
	previousSubscription: string;
	documents: SearchProjection["documents"];
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
export function parseEventWrite(value: unknown): EventWriteRequest | null {
	if (!isObject(value) || typeof value.value !== "string" || value.value.length > 1000 ||
		(value.requestId !== undefined && !isIdentifier(value.requestId)) ||
		(value.fault !== undefined && value.fault !== "none" && value.fault !== "after-save")) return null;
	return { value: value.value, ...(value.requestId === undefined ? {} : { requestId: value.requestId as string }),
		fault: value.fault === "after-save" ? "after-save" : "none" };
}
export function isQuarantinedRecord(value: unknown): value is QuarantinedRecord {
	return isObject(value) && typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id) &&
		typeof value.content === "string" && typeof value.timestamp_ms === "number" &&
		Number.isSafeInteger(value.timestamp_ms) && value.timestamp_ms >= 0 && typeof value.reason === "string" && value.reason.length > 0;
}
export function isSearchDocuments(value: unknown): value is SearchProjection["documents"] {
	return Array.isArray(value) && value.length <= 100 && value.every(document =>
		isObject(document) && isDocumentSnapshot(document) && document.version > 0 && isIdentifier(document.documentId)) &&
		new Set(value.map(document => document.documentId)).size === value.length;
}
export function isSearchRecoveryRequest(value: unknown): value is SearchRecoveryRequest {
	return isObject(value) && typeof value.subscription === "string" && typeof value.previousSubscription === "string" &&
		isSearchDocuments(value.documents);
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
		!value.processedEventIds.every(id => typeof id === "string") || !Array.isArray(value.quarantined) ||
		!value.quarantined.every(isQuarantinedRecord) || typeof value.historyComplete !== "boolean" ||
		typeof value.recoveryRequired !== "boolean") return false;
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
	return value === "none" || value === "after-first-effect" || value === "before-ack" || value === "before-quarantine";
}
