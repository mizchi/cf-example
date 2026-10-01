import { DurableObject } from "cloudflare:workers";
import { isDocumentUpdatedEvent, isObject, type ProjectionName, type ProjectionState } from "./event-contract";
import { applyDocumentEvent, emptyProjection } from "./event-projection";

export class EventProjectionStore extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get("name");
		const subscription = url.searchParams.get("subscription");
		if ((name !== "search" && name !== "audit") || !subscription) return new Response("Invalid projection", { status: 400 });
		if (request.method === "GET") return Response.json(await this.read(name, subscription));
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		if (url.pathname === "/reset") {
			const state = emptyProjection(name, `${subscription}-${crypto.randomUUID()}`);
			await this.ctx.storage.put("projection", state);
			return Response.json(state);
		}
		const body: unknown = await request.json().catch(() => null);
		if (!isObject(body) || !isDocumentUpdatedEvent(body.event)) return new Response("Invalid event", { status: 400 });
		const event = body.event;
		const state = await this.ctx.storage.transaction(async transaction => {
			const current = await transaction.get<ProjectionState>("projection") ?? emptyProjection(name, subscription);
			// Fence a consumer from the generation before a rebuild.
			if (body.subscription !== current.subscription) return null;
			const next = applyDocumentEvent(current, event);
			await transaction.put("projection", next);
			return next;
		});
		return state === null ? new Response("Projection was reset", { status: 409 }) : Response.json(state);
	}

	private async read(name: ProjectionName, subscription: string): Promise<ProjectionState> {
		return await this.ctx.storage.get<ProjectionState>("projection") ?? emptyProjection(name, subscription);
	}
}
