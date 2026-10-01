import { env } from "cloudflare:workers";
import { isConsumerFault, isObject, isProjectionState, type PipelineView, type ProjectionName, type ProjectionState } from "./event-contract";
import { createEventStream, transportMode } from "./event-transport";

async function projection(project: string, name: ProjectionName) {
	const stub = env.EVENT_PROJECTION.get(env.EVENT_PROJECTION.idFromName(`${project}:${name}`));
	// K2 subscription names are case-insensitive; hash the case-sensitive
	// project ID and leave room for a rebuild generation within 128 chars.
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(project));
	const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
	const url = `https://projection/?name=${name}&subscription=doc-${key}-${name}`;
	return { stub, url };
}
async function readProjection(project: string, name: ProjectionName): Promise<ProjectionState> {
	const { stub, url } = await projection(project, name);
	const response = await stub.fetch(url);
	const body: unknown = await response.json();
	if (!response.ok || !isProjectionState(body) || body.name !== name) throw new Error("Invalid projection response");
	return body;
}

async function consume(project: string, name: ProjectionName, request: Request): Promise<Response> {
	const text = await request.text();
	let body: unknown = {};
	try { if (text) body = JSON.parse(text); } catch { return new Response("Invalid JSON", { status: 400 }); }
	if (!isObject(body)) return new Response("Invalid consume options", { status: 400 });
	const fault = body.fault ?? "none";
	if (!isConsumerFault(fault) ||
		(body.reverse !== undefined && typeof body.reverse !== "boolean")) return new Response("Invalid consume options", { status: 400 });
	if ((fault !== "none" || body.reverse === true) && transportMode() !== "local") return new Response("Fault injection requires local transport", { status: 400 });
	const workerId = `${project}-${name}`;
	try {
		const current = await readProjection(project, name);
		const client = createEventStream(project);
		const batch = await client.consume(current.subscription, workerId);
		if (!batch) return Response.json({ records: 0 });
		const events = body.reverse === true ? [...batch.events].reverse() : batch.events;
		const { stub, url } = await projection(project, name);
		let applied = 0;
		for (const event of events) {
			// A shared remote stream can carry multiple demonstration projects.
			if (event.projectId !== project) continue;
			const response = await stub.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ event, subscription: current.subscription }) });
			if (!response.ok) throw new Error(`Projection update failed: HTTP ${response.status}`);
			applied++;
			if (fault === "after-first-effect" && applied === 1) throw new Error("Consumer stopped after first effect, before ack");
		}
		if (fault === "before-ack") throw new Error("Consumer stopped before ack");
		await client.ack(batch, workerId);
		return Response.json({ records: batch.events.length });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Consume failed" }, { status: 503 });
	}
}

export async function handlePipeline(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const match = /^\/api\/pipeline\/([a-zA-Z0-9-]{1,64})(\/.*)$/.exec(url.pathname);
	if (!match) return new Response("Invalid pipeline path", { status: 400 });
	const [, project, path] = match;
	let response: Response;
	const document = /^\/documents\/([a-zA-Z0-9-]{1,64})(\/publish)?$/.exec(path);
	const consumer = /^\/consume\/(search|audit)$/.exec(path);
	const reset = /^\/projections\/(search|audit)\/reset$/.exec(path);
	if (document) {
		response = await env.EVENT_DOCUMENT.get(env.EVENT_DOCUMENT.idFromName(`${project}:${document[1]}`)).fetch(request);
	} else if (path === "/projections" && request.method === "GET") {
		const [search, audit] = await Promise.all([readProjection(project, "search"), readProjection(project, "audit")]);
		if (search.name !== "search" || audit.name !== "audit") throw new Error("Invalid projection types");
		const query = (url.searchParams.get("q") ?? "").toLocaleLowerCase();
		const view: PipelineView = { transport: transportMode(), search: { ...search,
			documents: search.documents.filter(document => document.value.toLocaleLowerCase().includes(query)) }, audit };
		response = Response.json(view);
	} else if (consumer && request.method === "POST") {
		response = await consume(project, consumer[1] as ProjectionName, request);
	} else if (reset && request.method === "POST") {
		const { stub, url: projectionUrl } = await projection(project, reset[1] as ProjectionName);
		response = await stub.fetch(projectionUrl.replace("/?", "/reset?"), { method: "POST" });
	} else response = new Response("Not found or method not allowed", { status: document || consumer || reset || path === "/projections" ? 405 : 404 });
	return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), "Cache-Control": "no-store" } });
}
