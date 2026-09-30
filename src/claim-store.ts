import { DurableObject } from "cloudflare:workers";

export class ClaimStore extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		const mode = new URL(request.url).pathname.split("/").at(-1);
		if (mode !== "naive" && mode !== "safe") return new Response("Not found", { status: 404 });

		if (mode === "naive") {
			const claimed = (await this.ctx.storage.get<boolean>("claimed")) ?? false;
			if (claimed) return Response.json({ claimed: false });
			// Represents an external fetch: other requests may enter while it is awaited.
			await scheduler.wait(100);
			await this.ctx.storage.put("claimed", true);
			return Response.json({ claimed: true });
		}

		const reserved = await this.ctx.storage.transaction(async (transaction) => {
			const claimed = (await transaction.get<boolean>("claimed")) ?? false;
			if (claimed) return false;
			await transaction.put("claimed", true);
			return true;
		});
		if (!reserved) return Response.json({ claimed: false });
		await scheduler.wait(100);
		return Response.json({ claimed: true });
	}
}
