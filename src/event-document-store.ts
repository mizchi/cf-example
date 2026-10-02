import { DurableObject } from "cloudflare:workers";
import type { DocumentSnapshot } from "./document-contract";
import { eventId, isIdentifier, isObject, isPublishFault, parseEventWrite, type DocumentUpdatedEvent, type EventDocumentView, type PublishFault } from "./event-contract";
import { createEventStream, transportMode } from "./event-transport";
import { registerSourceDocument } from "./event-source";

const initial: DocumentSnapshot = { value: "", version: 0 };

export class EventDocumentStore extends DurableObject {
	private async view(): Promise<EventDocumentView> {
		return this.ctx.storage.transaction(async transaction => ({
			document: await transaction.get<DocumentSnapshot>("document") ?? initial,
			pending: [...(await transaction.list<DocumentUpdatedEvent>({ prefix: "outbox:" })).values()],
		}));
	}

	async fetch(request: Request): Promise<Response> {
		if (/^\/api\/pipeline\/[a-zA-Z0-9-]{1,64}\/catalog$/.test(new URL(request.url).pathname)) {
			if (request.method === "GET") {
				const entries = await this.ctx.storage.list({ prefix: "catalog:", limit: 101 });
				if (entries.size > 100) return Response.json({ error: "This demo supports snapshots of at most 100 documents" }, { status: 409 });
				return Response.json({ documentIds: [...entries.keys()].map(key => key.slice("catalog:".length)) });
			}
			const body: unknown = await request.json().catch(() => null);
			if (request.method !== "POST" || !isObject(body) || !isIdentifier(body.documentId)) return new Response("Invalid catalog request", { status: 400 });
			await this.ctx.storage.put(`catalog:${body.documentId}`, true);
			return Response.json({ registered: true });
		}
		const match = /^\/api\/pipeline\/([a-zA-Z0-9-]{1,64})\/documents\/([a-zA-Z0-9-]{1,64})(\/publish)?$/.exec(new URL(request.url).pathname);
		if (!match) return new Response("Not found", { status: 404 });
		const [, projectId, documentId, publishing] = match;
		if (request.method === "GET" && !publishing) return Response.json(await this.view());
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		const text = await request.text();
		let body: unknown = {};
		try { if (text) body = JSON.parse(text); } catch { return new Response("Invalid JSON", { status: 400 }); }
		if (publishing) {
			if (!isObject(body)) return new Response("Invalid publish options", { status: 400 });
			const fault: unknown = body.fault ?? "none";
			if (!isPublishFault(fault)) return new Response("Invalid publish fault", { status: 400 });
			if (fault !== "none" && transportMode() !== "local") return new Response("Fault injection requires local transport", { status: 400 });
			await registerSourceDocument(projectId, documentId);
			return this.publish(projectId, fault);
		}
		const write = parseEventWrite(body);
		if (!write || (write.fault !== "none" && (transportMode() !== "local" || !write.requestId))) return new Response("Invalid write options", { status: 400 });
		const { value, requestId } = write;
		// Register only validated writes, before changing the source document.
		await registerSourceDocument(projectId, documentId);
		const result = await this.ctx.storage.transaction(async transaction => {
			const key = requestId === undefined ? null : `request:${requestId}`;
			const receipt = key ? await transaction.get<{ value: string; result: EventDocumentView }>(key) : undefined;
			if (receipt) return receipt.value === value ? receipt.result : null;
			const current = await transaction.get<DocumentSnapshot>("document") ?? initial;
			const next: DocumentSnapshot = { value, version: current.version + 1 };
			const event: DocumentUpdatedEvent = { ...next, type: "document.updated", schemaVersion: 1,
				projectId, documentId, eventId: eventId(projectId, documentId, next.version), occurredAt: Date.now() };
			// Saving a document always leaves a durable event to publish.
			await transaction.put("document", next);
			await transaction.put(`outbox:${String(next.version).padStart(16, "0")}`, event);
			const result = { document: next, pending: [...(await transaction.list<DocumentUpdatedEvent>({ prefix: "outbox:" })).values()] };
			if (key) await transaction.put(key, { value, result });
			return result;
		});
		if (!result) return Response.json({ error: "requestId was already used with different content" }, { status: 409 });
		if (write.fault === "after-save") return Response.json({ error: "Save response lost after commit" }, { status: 503 });
		return Response.json(result);
	}

	private async publish(projectId: string, fault: PublishFault): Promise<Response> {
		const pending = await this.ctx.storage.list<DocumentUpdatedEvent>({ prefix: "outbox:", limit: 100 });
		if (pending.size === 0) return Response.json({ sent: 0, pending: 0 });
		try {
			if (fault === "before-send") throw new Error("Publication stopped before send");
			await createEventStream(projectId).produce([...pending.values()]);
			if (fault === "after-send") throw new Error("Publication response lost after send");
			// Delete only the events in this attempt; a concurrent save may
			// have added more. Retrying a lost response uses the same IDs.
			await this.ctx.storage.delete([...pending.keys()]);
			return Response.json({ sent: pending.size, pending: (await this.view()).pending.length });
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : "Publication failed", pending: (await this.view()).pending.length }, { status: 503 });
		}
	}
}
