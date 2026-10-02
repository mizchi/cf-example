import { env } from "cloudflare:workers";
import { isEventDocumentView, isIdentifier, isObject, type SearchProjection } from "./event-contract";

function catalog(project: string) {
	// The doubled separator cannot collide with a document's identifier.
	return env.EVENT_DOCUMENT.get(env.EVENT_DOCUMENT.idFromName(`${project}::catalog`));
}
export async function registerSourceDocument(project: string, documentId: string): Promise<void> {
	const response = await catalog(project).fetch(`https://source/api/pipeline/${project}/catalog`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId }),
	});
	if (!response.ok) throw new Error("Document registration failed");
}
export async function sourceSnapshot(project: string): Promise<SearchProjection["documents"]> {
	const response = await catalog(project).fetch(`https://source/api/pipeline/${project}/catalog`);
	const body: unknown = await response.json();
	if (!response.ok || !isObject(body) || !Array.isArray(body.documentIds) || !body.documentIds.every(isIdentifier)) throw new Error("Invalid source catalog");
	const snapshots = await Promise.all(body.documentIds.map(async documentId => {
		const stub = env.EVENT_DOCUMENT.get(env.EVENT_DOCUMENT.idFromName(`${project}:${documentId}`));
		const response = await stub.fetch(`https://source/api/pipeline/${project}/documents/${documentId}`);
		const view: unknown = await response.json();
		if (!response.ok || !isEventDocumentView(view)) throw new Error("Invalid source snapshot");
		return { documentId, ...view.document };
	}));
	return snapshots.filter(document => document.version > 0);
}
