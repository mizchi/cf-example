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
	const writeFault = element<HTMLSelectElement>("#pipeline-write-fault");
	let pendingWrite: { requestId: string; value: string } | null = null;
	let busy = false;
	let remote = false;

	async function refresh(): Promise<void> {
		const [documentResponse, projectionResponse] = await Promise.all([
			fetch(`${base}/documents/article`), fetch(`${base}/projections?q=${encodeURIComponent(query.value)}`),
		]);
		const [source, view]: unknown[] = await Promise.all([documentResponse.json(), projectionResponse.json()]);
		if (!documentResponse.ok || !projectionResponse.ok || !isEventDocumentView(source) || !isPipelineView(view)) throw new Error("Invalid pipeline response");
		remote = view.transport === "remote";
		element("#pipeline-project").textContent = project;
		element("#pipeline-mode").textContent = view.transport === "local" ? "ローカルのイベントログ" : "Cloudflare K2";
		element("[data-testid=pipeline-pending]").textContent = String(source.pending.length);
		element("#pipeline-version").textContent = String(source.document.version);
		element("#pipeline-source").textContent = source.document.value || "まだ保存されていません";
		element("[data-testid=pipeline-audit-count]").textContent = String(view.audit.totalUpdates);
		element("#pipeline-audit").textContent = view.audit.events.map(event => `v${event.version}: ${event.value}`).join("\n") || "まだ処理されていません";
		element("[data-testid=pipeline-search]").textContent = view.search.documents.map(document => `${document.documentId} / v${document.version}\n${document.value}`).join("\n\n") || "検索結果はありません";
		for (const projection of [view.search, view.audit]) {
			element(`#pipeline-${projection.name}-health`).textContent = projection.recoveryRequired ? "履歴欠落：現在の文書から復旧が必要です。"
				: projection.historyComplete ? "検出済みの履歴欠落はありません。"
					: projection.name === "search" ? "履歴欠落：過去ログからの完全な再構築はできません。" : "履歴欠落：件数は処理できた更新だけです。";
			element(`#pipeline-${projection.name}-quarantine`).textContent = `隔離 ${projection.quarantined.length} 件` +
				projection.quarantined.map(record => `\n${record.reason}\n${record.content}`).join("");
		}
		for (const control of [publishFault, consumerFault, reverse, writeFault, element<HTMLButtonElement>("#pipeline-poison"), element<HTMLButtonElement>("#pipeline-expire")]) control.disabled = view.transport !== "local";
	}

	async function act(path: string, body?: unknown): Promise<boolean> {
		if (busy) return false;
		busy = true;
		let succeeded = false;
		const buttons = section.querySelectorAll<HTMLButtonElement>("button");
		buttons.forEach(button => { button.disabled = true; });
		try {
			const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
			const result: unknown = await response.json().catch(() => null);
			if (!response.ok) throw new Error(isObject(result) && typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
			feedback.textContent = "処理が完了しました。";
			succeeded = true;
		} catch (error) {
			feedback.textContent = error instanceof Error ? error.message : "処理に失敗しました。";
		} finally {
			await refresh().catch(() => { feedback.textContent += " 状態を読み込めませんでした。"; });
			busy = false;
			buttons.forEach(button => { button.disabled = remote && (button.id === "pipeline-poison" || button.id === "pipeline-expire"); });
		}
		return succeeded;
	}
	element<HTMLFormElement>("#pipeline-form").addEventListener("submit", event => {
		event.preventDefault();
		if (!pendingWrite || pendingWrite.value !== value.value) pendingWrite = { requestId: crypto.randomUUID(), value: value.value };
		const operation = pendingWrite;
		void act("/documents/article", { ...operation, fault: writeFault.value }).then(succeeded => {
			if (succeeded && pendingWrite === operation) pendingWrite = null;
		});
	});
	element("#pipeline-publish").addEventListener("click", () => { void act("/documents/article/publish", { fault: publishFault.value }); });
	element("#pipeline-search-consume").addEventListener("click", () => { void act("/consume/search", { fault: consumerFault.value, reverse: reverse.checked }); });
	element("#pipeline-audit-consume").addEventListener("click", () => { void act("/consume/audit", { fault: consumerFault.value }); });
	element("#pipeline-rebuild").addEventListener("click", () => { void act("/projections/search/reset"); });
	element("#pipeline-recover").addEventListener("click", () => { void act("/projections/search/recover"); });
	element("#pipeline-poison").addEventListener("click", () => { void act("/faults/poison"); });
	element("#pipeline-expire").addEventListener("click", () => { void act("/faults/expire"); });
	query.addEventListener("input", () => { void refresh().catch(() => { feedback.textContent = "検索結果を読み込めませんでした。"; }); });
	void refresh().catch(() => { feedback.textContent = "状態を読み込めませんでした。"; });
}
