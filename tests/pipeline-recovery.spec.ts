import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { recoveryPatternOracle } from "./quint-oracle";
import { emptyProjection, recoverSearch } from "../src/event-projection";

test("復旧 snapshot より新しい反映済みの文書を巻き戻さない", () => {
	const current = { ...emptyProjection("search", "old"), name: "search" as const,
		documents: [{ documentId: "article", value: "concurrent", version: 3 }] };
	const recovered = recoverSearch(current, "new", [{ documentId: "article", value: "snapshot", version: 2 }]);
	expect(recovered.documents).toEqual(current.documents);
	expect(recovered.subscription).toBe("new");
});

test("画面で保存応答の喪失を再試行し、隔離と期限切れ復旧を試せる", async ({ page }) => {
	await page.goto(`/?project=${randomUUID()}`);
	await page.getByLabel("イベント用の文書内容").fill("one update");
	await page.getByLabel("保存時の障害").selectOption("after-save");
	await page.getByRole("button", { name: "文書を保存", exact: true }).click();
	await expect(page.locator("#pipeline-version")).toHaveText("1");
	await page.getByLabel("保存時の障害").selectOption("none");
	await page.getByRole("button", { name: "文書を保存", exact: true }).click();
	await expect(page.locator("#pipeline-version")).toHaveText("1");
	await page.getByRole("button", { name: "イベントを発行" }).click();
	await page.getByRole("button", { name: "処理できないイベントを追加" }).click();
	await page.getByRole("button", { name: "監査を更新" }).click();
	await expect(page.locator("#pipeline-audit-quarantine")).toContainText("隔離 1 件");
	await page.getByRole("button", { name: "ログの期限切れを再現" }).click();
	await page.getByRole("button", { name: "検索を更新", exact: true }).click();
	await expect(page.locator("#pipeline-search-health")).toContainText("復旧が必要");
	await page.getByRole("button", { name: "現在の文書から検索を復旧" }).click();
	await expect(page.getByTestId("pipeline-search")).toContainText("one update");
	await expect(page.locator("#pipeline-search-health")).toContainText("履歴欠落");
});

test("期限切れで検索を現在の全登録文書から復旧し、監査の欠落件数を捏造しない", async ({ request }) => {
	const oracle = recoveryPatternOracle("retentionRecovery");
	const base = `/api/pipeline/${randomUUID()}`;
	for (const document of ["article", "other"]) {
		await request.post(`${base}/documents/${document}`, { data: { value: document } });
		await request.post(`${base}/documents/${document}/publish`);
	}
	await request.post(`${base}/consume/audit`);
	await request.post(`${base}/documents/article`, { data: { value: "latest" } });
	await request.post(`${base}/documents/article/publish`);
	expect((await request.post(`${base}/faults/expire`)).ok()).toBe(true);
	expect((await request.post(`${base}/consume/search`)).status()).toBe(409);
	await request.post(`${base}/consume/audit`);
	const missing = await (await request.get(`${base}/projections`)).json();
	expect(missing.search.recoveryRequired).toBe(true);
	expect(missing.audit.totalUpdates).toBe(2);
	expect(missing.audit.historyComplete).toBe(false);
	expect((await request.post(`${base}/projections/search/recover`)).ok()).toBe(true);
	const recovered = await (await request.get(`${base}/projections`)).json();
	expect(recovered.search.documents).toEqual([
		{ documentId: "article", value: "latest", version: 2 },
		{ documentId: "other", value: "other", version: 1 },
	]);
	expect(recovered.search.recoveryRequired).toBe(false);
	expect(recovered.search.historyComplete).toBe(false);
	expect(recovered.audit.totalUpdates).toBe(2);
	await request.post(`${base}/documents/article`, { data: { value: "after recovery" } });
	await request.post(`${base}/documents/article/publish`);
	await request.post(`${base}/consume/search`);
	await request.post(`${base}/consume/audit`);
	const continued = await (await request.get(`${base}/projections`)).json();
	expect(continued.search.documents.find((item: { documentId: string }) => item.documentId === "article")).toMatchObject({ value: "after recovery", version: 3 });
	expect(continued.audit.totalUpdates).toBe(3);
	expect(continued.audit.historyComplete).toBe(false);
	expect(continued.search.documents.find((item: { documentId: string }) => item.documentId === "article").version, oracle.actions.join(" → ")).toBe(oracle.final.search);
});

test("保存応答を失って再送しても一つの文書更新と outbox になる", async ({ request }) => {
	const oracle = recoveryPatternOracle("saveRequest");
	const base = `/api/pipeline/${randomUUID()}`;
	const operation = { value: "saved once", requestId: randomUUID() };
	const lost = await request.post(`${base}/documents/article`, { data: { ...operation, fault: "after-save" } });
	expect(lost.status()).toBe(503);
	const retry = await request.post(`${base}/documents/article`, { data: operation });
	expect(retry.ok()).toBe(true);
	const result = await retry.json();
	expect(result.document).toEqual({ value: operation.value, version: 1 });
	expect(result.pending).toHaveLength(1);
	expect(result.document.version, oracle.actions.join(" → ")).toBe(oracle.final.version);
	await request.post(`${base}/documents/article/publish`);
	const replay = await request.post(`${base}/documents/article`, { data: operation });
	expect(await replay.json()).toEqual(result);
	expect((await (await request.get(`${base}/documents/article`)).json()).pending).toEqual([]);
	await request.post(`${base}/consume/audit`);
	expect((await (await request.get(`${base}/projections`)).json()).audit.totalUpdates).toBe(1);
});

test("同じ requestId の同時保存は一度だけ、異なる内容での使い回しは拒否する", async ({ request }) => {
	const base = `/api/pipeline/${randomUUID()}`;
	const requestId = randomUUID();
	const responses = await Promise.all([1, 2].map(() => request.post(`${base}/documents/article`, { data: { value: "same", requestId } })));
	expect(responses.every(response => response.ok())).toBe(true);
	const results = await Promise.all(responses.map(response => response.json()));
	expect(results[0]).toEqual(results[1]);
	expect(results[0].document.version).toBe(1);
	expect((await request.post(`${base}/documents/article`, { data: { value: "different", requestId } })).status()).toBe(409);
	expect((await request.post(`${base}/documents/article`, { data: { value: "same", requestId: [] } })).status()).toBe(400);
	expect((await request.post(`${base}/documents/other`, { data: { value: "other", requestId } })).ok()).toBe(true);
});

test("隔離前に停止した batch は ack せず、再送で正常イベントと隔離を一度ずつ保存する", async ({ request }) => {
	const oracle = recoveryPatternOracle("poisonEvents");
	const base = `/api/pipeline/${randomUUID()}`;
	await request.post(`${base}/documents/article`, { data: { value: "first" } });
	await request.post(`${base}/documents/article/publish`);
	expect((await request.post(`${base}/faults/poison`)).ok()).toBe(true);
	await request.post(`${base}/documents/article`, { data: { value: "second" } });
	await request.post(`${base}/documents/article/publish`);
	const stopped = await request.post(`${base}/consume/audit`, { data: { fault: "before-quarantine" } });
	expect(stopped.status()).toBe(503);
	const partial = await (await request.get(`${base}/projections`)).json();
	expect(partial.audit.totalUpdates).toBe(1);
	expect(partial.audit.quarantined).toEqual([]);
	const retried = await request.post(`${base}/consume/audit`, { data: { fault: "before-ack" } });
	expect(retried.status()).toBe(503);
	const beforeAck = await (await request.get(`${base}/projections`)).json();
	expect(beforeAck.audit.totalUpdates).toBe(2);
	expect(beforeAck.audit.quarantined).toHaveLength(1);
	expect(beforeAck.audit.quarantined[0]).toMatchObject({ reason: "Invalid document.updated record" });
	expect((await request.post(`${base}/consume/audit`)).ok()).toBe(true);
	const complete = await (await request.get(`${base}/projections`)).json();
	expect(complete.audit.totalUpdates).toBe(2);
	expect(complete.audit.quarantined).toEqual(beforeAck.audit.quarantined);
	expect(complete.audit.quarantined.length, oracle.actions.join(" → ")).toBe(oracle.final.quarantineCount);
	expect((await (await request.post(`${base}/consume/audit`)).json()).records).toBe(0);
	expect((await request.post(`${base}/consume/search`)).ok()).toBe(true);
	const searched = await (await request.get(`${base}/projections`)).json();
	expect(searched.search.documents[0]).toMatchObject({ value: "second", version: 2 });
	expect(searched.search.quarantined).toHaveLength(1);
	await request.post(`${base}/projections/search/reset`);
	expect((await (await request.get(`${base}/projections`)).json()).search.quarantined).toEqual(searched.search.quarantined);
	await request.post(`${base}/consume/search`);
	expect((await (await request.get(`${base}/projections`)).json()).search.quarantined).toEqual(searched.search.quarantined);
});
