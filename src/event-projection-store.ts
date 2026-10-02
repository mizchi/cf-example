import { DurableObject } from "cloudflare:workers";
import { isDocumentUpdatedEvent, isObject, isQuarantinedRecord, isSearchRecoveryRequest, type ProjectionName, type ProjectionState } from "./event-contract";
import { applyDocumentEvent, commitSearchRecovery, emptyProjection, markHistoryGap, quarantineRecord, upgradeProjection } from "./event-projection";

export class EventProjectionStore extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get("name");
		const subscription = url.searchParams.get("subscription");
		if ((name !== "search" && name !== "audit") || !subscription) return new Response("Invalid projection", { status: 400 });
		if (request.method === "GET") return Response.json(await this.read(name, subscription));
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		if (url.pathname === "/reset") {
			const state = await this.ctx.storage.transaction(async transaction => {
				const current = upgradeProjection(await transaction.get<ProjectionState>("projection") ?? emptyProjection(name, subscription));
				const next = { ...emptyProjection(name, `${subscription}-${crypto.randomUUID()}`),
					quarantined: current.quarantined, historyComplete: current.historyComplete };
				await transaction.put("projection", next);
				return next;
			});
			return Response.json(state);
		}
		const body: unknown = await request.json().catch(() => null);
		const isolating = url.pathname === "/quarantine";
		const recovering = url.pathname === "/recover";
		const gap = url.pathname === "/history-gap";
		if (!isObject(body) || typeof body.subscription !== "string" ||
			(recovering ? name !== "search" || !isSearchRecoveryRequest(body)
				: gap ? false : isolating ? !isQuarantinedRecord(body.record) : !isDocumentUpdatedEvent(body.event))) return new Response("Invalid disposition", { status: 400 });
		const state = await this.ctx.storage.transaction(async transaction => {
			const current = upgradeProjection(await transaction.get<ProjectionState>("projection") ?? emptyProjection(name, subscription));
			// Generation comparison and persistence share this transaction.
			let next: ProjectionState;
			if (recovering) {
				if (current.name !== "search" || !isSearchRecoveryRequest(body)) return null;
				const recovered = commitSearchRecovery(current, body);
				if (!recovered) return null;
				next = recovered;
			} else {
				if (body.subscription !== current.subscription) return null;
				if (gap) next = markHistoryGap(current);
				else if (isolating && isQuarantinedRecord(body.record)) next = quarantineRecord(current, body.record);
				else if (isDocumentUpdatedEvent(body.event)) next = applyDocumentEvent(current, body.event);
				else return null;
			}
			await transaction.put("projection", next);
			return next;
		});
		return state === null ? new Response("Projection was reset", { status: 409 }) : Response.json(state);
	}

	private async read(name: ProjectionName, subscription: string): Promise<ProjectionState> {
		return upgradeProjection(await this.ctx.storage.get<ProjectionState>("projection") ?? emptyProjection(name, subscription));
	}
}
