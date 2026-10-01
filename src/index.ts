import { env } from "cloudflare:workers";
import type { HelloResponse } from "./contract";
import { handlePipeline } from "./pipeline-api";
import { isDocumentSnapshot, parseWriteBody, type WriteResult } from "./document-contract";
export { DocumentStore } from "./document-store";
export { ClaimStore } from "./claim-store";
export { EventDocumentStore } from "./event-document-store";
export { EventProjectionStore } from "./event-projection-store";
export { LocalK2Stream } from "./local-k2-stream";

export default {
	async fetch(request, _env, ctx) {
		const path = new URL(request.url).pathname;
		if (path.startsWith("/api/pipeline/")) return handlePipeline(request);
		if (path === "/api/hello") {
			const data: HelloResponse = { message: `Hello ${env.WORLD}!` };
			return Response.json(data);
		}
		const claim = /^\/api\/claims\/([a-zA-Z0-9-]{1,64})\/(naive|safe)$/.exec(path);
		if (claim) {
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			const stub = env.CLAIM.get(env.CLAIM.idFromName(claim[1]));
			return stub.fetch(request);
		}
		const match = /^\/api\/documents\/([a-zA-Z0-9-]{1,64})$/.exec(path);
		if (match) {
			const id = match[1];
			const stub = env.DOCUMENT.get(env.DOCUMENT.idFromName(id));
			if (request.method === "GET") {
				const response = await stub.fetch(request);
				return new Response(response.body, {
					status: response.status,
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": "public, max-age=60",
						"Cache-Tag": `document-${id}`,
					},
				});
			}
			if (request.method === "POST") {
				const value = parseWriteBody(await request.json().catch(() => null));
				if (value === null) return new Response("Invalid value", { status: 400 });
				const response = await stub.fetch(new Request(request.url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ value }),
				}));
				const body: unknown = await response.json();
				if (!response.ok || !isDocumentSnapshot(body)) return new Response("Storage error", { status: 502 });
				let purged = false;
				if (ctx.cache) {
					try {
						const result = await ctx.cache.purge({ tags: [`document-${id}`] });
						purged = result.success;
						if (!purged) console.error("Cache purge failed", result.errors);
					} catch (error) {
						console.error("Cache purge failed", error);
					}
				}
				const result: WriteResult = { ...body, purged };
				return Response.json(result, { headers: { "Cache-Control": "no-store" } });
			}
			return new Response("Method not allowed", { status: 405 });
		}
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler;
