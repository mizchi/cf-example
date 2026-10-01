import { DurableObject } from "cloudflare:workers";
import { parseWriteBody, type DocumentSnapshot } from "./document-contract";
import { eventId, isObject, isPublishFault, type DocumentUpdatedEvent, type EventDocumentView, type PublishFault } from "./event-contract";
import { createEventStream, transportMode } from "./event-transport";

const initial: DocumentSnapshot = { value: "", version: 0 };

export class EventDocumentStore extends DurableObject {
	private async view(): Promise<EventDocumentView> {
		return this.ctx.storage.transaction(async transaction => ({
			document: await transaction.get<DocumentSnapshot>("document") ?? initial,
			pending: [...(await transaction.list<DocumentUpdatedEvent>({ prefix: "outbox:" })).values()],
		}));
	}

	async fetch(request: Request): Promise<Response> {
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
			return this.publish(projectId, fault);
		}
		const value = parseWriteBody(body);
		if (value === null) return new Response("Invalid value", { status: 400 });
		const result = await this.ctx.storage.transaction(async transaction => {
			const current = await transaction.get<DocumentSnapshot>("document") ?? initial;
			const next: DocumentSnapshot = { value, version: current.version + 1 };
			const event: DocumentUpdatedEvent = { ...next, type: "document.updated", schemaVersion: 1,
				projectId, documentId, eventId: eventId(projectId, documentId, next.version), occurredAt: Date.now() };
			// Saving a document always leaves a durable event to publish.
			await transaction.put("document", next);
			await transaction.put(`outbox:${String(next.version).padStart(16, "0")}`, event);
			return { document: next, pending: [...(await transaction.list<DocumentUpdatedEvent>({ prefix: "outbox:" })).values()] };
		});
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
