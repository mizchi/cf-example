import { acceptSnapshot, isDocumentSnapshot, isWriteResult, type DocumentSnapshot } from "./document-contract";

export function mountDocument(): void {
	const form = document.querySelector<HTMLFormElement>("#document-form");
	const input = document.querySelector<HTMLInputElement>("#document-input");
	const value = document.querySelector<HTMLOutputElement>("[data-testid=document-value]");
	const version = document.querySelector<HTMLOutputElement>("[data-testid=document-version]");
	const readStatus = document.querySelector<HTMLOutputElement>("[data-testid=document-get-status]");
	const feedback = document.querySelector<HTMLParagraphElement>("#document-feedback");
	if (!form || !input || !value || !version || !readStatus || !feedback) throw new Error("Missing document UI");

	const id = new URL(location.href).searchParams.get("doc") ?? "demo";
	const path = `/api/documents/${encodeURIComponent(id)}`;
	let current: DocumentSnapshot | null = null;
	const show = (incoming: DocumentSnapshot): void => {
		current = acceptSnapshot(current, incoming);
		value.textContent = current.value;
		version.textContent = String(current.version);
	};

	fetch(path).then(async (response) => {
		if (!response.ok) throw new Error(`Read failed: ${response.status}`);
		const body: unknown = await response.json();
		if (!isDocumentSnapshot(body)) throw new Error("Invalid document response");
		show(body);
		readStatus.textContent = "Loaded";
	}).catch((error: unknown) => {
		readStatus.textContent = "Failed";
		feedback.textContent = String(error);
	});

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const response = await fetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: input.value }),
		});
		if (!response.ok) {
			feedback.textContent = `Save failed: ${response.status}`;
			return;
		}
		const body: unknown = await response.json();
		if (!isWriteResult(body)) {
			feedback.textContent = "Invalid save response";
			return;
		}
		show(body);
		feedback.textContent = body.purged ? "Saved; cache purge accepted" : "Saved; cache purge not confirmed";
	});
}
