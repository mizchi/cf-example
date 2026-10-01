import { isEventDocumentView, isIdentifier, isObject, isPipelineView } from "./event-contract";

export function mountPipeline(): void {
	const root = document.querySelector<HTMLElement>("#pipeline");
	if (!root) throw new Error("Missing pipeline section");
	const section = root;
	const requested = new URL(location.href).searchParams.get("project") ?? "demo";
	const project = isIdentifier(requested) ? requested : "demo";
	const base = `/api/pipeline/${project}`;
	function element<T = HTMLElement>(selector: string): T {
		const found = section.querySelector(selector);
		if (!found) throw new Error(`Missing pipeline element ${selector}`);
		return found as T;
	}
	const feedback = element("#pipeline-feedback");
	const value = element<HTMLTextAreaElement>("#pipeline-value");
	const query = element<HTMLInputElement>("#pipeline-query");
	const publishFault = element<HTMLSelectElement>("#pipeline-publish-fault");
	const consumerFault = element<HTMLSelectElement>("#pipeline-consumer-fault");
	const reverse = element<HTMLInputElement>("#pipeline-reverse");
	let busy = false;

	async function refresh(): Promise<void> {
		const [documentResponse, projectionResponse] = await Promise.all([
			fetch(`${base}/documents/article`), fetch(`${base}/projections?q=${encodeURIComponent(query.value)}`),
		]);
		const [source, view]: unknown[] = await Promise.all([documentResponse.json(), projectionResponse.json()]);
		if (!documentResponse.ok || !projectionResponse.ok || !isEventDocumentView(source) || !isPipelineView(view)) throw new Error("Invalid pipeline response");
		element("#pipeline-project").textContent = project;
		element("#pipeline-mode").textContent = view.transport === "local" ? "ローカルのイベントログ" : "Cloudflare K2";
		element("[data-testid=pipeline-pending]").textContent = String(source.pending.length);
		element("#pipeline-version").textContent = String(source.document.version);
		element("#pipeline-source").textContent = source.document.value || "まだ保存されていません";
		element("[data-testid=pipeline-audit-count]").textContent = String(view.audit.totalUpdates);
		element("#pipeline-audit").textContent = view.audit.events.map(event => `v${event.version}: ${event.value}`).join("\n") || "まだ処理されていません";
		element("[data-testid=pipeline-search]").textContent = view.search.documents.map(document => `${document.documentId} / v${document.version}\n${document.value}`).join("\n\n") || "検索結果はありません";
		for (const control of [publishFault, consumerFault, reverse]) control.disabled = view.transport !== "local";
	}

	async function act(path: string, body?: unknown): Promise<void> {
		if (busy) return;
		busy = true;
		const buttons = section.querySelectorAll<HTMLButtonElement>("button");
		buttons.forEach(button => { button.disabled = true; });
		try {
			const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
			const result: unknown = await response.json().catch(() => null);
			if (!response.ok) throw new Error(isObject(result) && typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
			feedback.textContent = "処理が完了しました。";
		} catch (error) {
			feedback.textContent = error instanceof Error ? error.message : "処理に失敗しました。";
		} finally {
			await refresh().catch(() => { feedback.textContent += " 状態を読み込めませんでした。"; });
			busy = false;
			buttons.forEach(button => { button.disabled = false; });
		}
	}
	element<HTMLFormElement>("#pipeline-form").addEventListener("submit", event => {
		event.preventDefault();
		void act("/documents/article", { value: value.value });
	});
	element("#pipeline-publish").addEventListener("click", () => { void act("/documents/article/publish", { fault: publishFault.value }); });
	element("#pipeline-search-consume").addEventListener("click", () => { void act("/consume/search", { fault: consumerFault.value, reverse: reverse.checked }); });
	element("#pipeline-audit-consume").addEventListener("click", () => { void act("/consume/audit", { fault: consumerFault.value }); });
	element("#pipeline-rebuild").addEventListener("click", () => { void act("/projections/search/reset"); });
	query.addEventListener("input", () => { void refresh().catch(() => { feedback.textContent = "検索結果を読み込めませんでした。"; }); });
	void refresh().catch(() => { feedback.textContent = "状態を読み込めませんでした。"; });
}
