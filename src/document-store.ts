import { DurableObject } from "cloudflare:workers";
import { isDocumentSnapshot, parseWriteBody, type DocumentSnapshot } from "./document-contract";

const initial: DocumentSnapshot = { value: "", version: 0 };

export class DocumentStore extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		if (request.method === "GET") {
			const stored: unknown = await this.ctx.storage.get("document");
			return Response.json(isDocumentSnapshot(stored) ? stored : initial);
		}
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		const value = parseWriteBody(await request.json().catch(() => null));
		if (value === null) return new Response("Invalid value", { status: 400 });
		const next = await this.ctx.storage.transaction(async (transaction) => {
			const stored: unknown = await transaction.get("document");
			const current = isDocumentSnapshot(stored) ? stored : initial;
			const snapshot: DocumentSnapshot = { value, version: current.version + 1 };
			await transaction.put("document", snapshot);
			return snapshot;
		});
		return Response.json(next);
	}
}
