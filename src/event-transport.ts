import { env } from "cloudflare:workers";
import { K2Client } from "./k2-client";
import { isObject } from "./event-contract";

// Application-owned simulator controls. These are NOT K2 HTTP API routes.
export async function localHistoryGap(project: string, subscription: string, resume = false): Promise<boolean | null> {
	if (transportMode() !== "local") return null;
	const response = await env.EVENT_STREAM.get(env.EVENT_STREAM.idFromName(project)).fetch("https://local-k2/history", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: subscription, resume }),
	});
	const body: unknown = await response.json();
	if (!response.ok || !isObject(body) || !isObject(body.result) || typeof body.result.gap !== "boolean") throw new Error("Invalid local history response");
	return body.result.gap;
}

export function transportMode(): "local" | "remote" {
	return env.K2_ENDPOINT ? "remote" : "local";
}

export function createEventStream(projectId: string): K2Client {
	if (!env.K2_ENDPOINT) {
		const stub = env.EVENT_STREAM.get(env.EVENT_STREAM.idFromName(projectId));
		return new K2Client((path, body) => stub.fetch(`https://local-k2${path}`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
		}));
	}
	const endpoint = new URL(env.K2_ENDPOINT);
	if (endpoint.protocol !== "https:" || !/^[a-f0-9]{32}\.k2\.cloudflarestorage\.com$/.test(endpoint.hostname) ||
		endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
		throw new Error("Invalid K2_ENDPOINT");
	}
	if (!env.K2_API_TOKEN) throw new Error("K2_API_TOKEN is required for remote K2");
	return new K2Client((path, body) => fetch(new URL(path, endpoint), {
		method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.K2_API_TOKEN}` }, body: JSON.stringify(body),
	}));
}
