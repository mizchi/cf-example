import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { documentEventOracle } from "./quint-oracle";

test("保存成功・発行失敗から回復し、検索と監査が独立に追いつく", async ({ request }) => {
	const base = `/api/pipeline/${randomUUID()}`;
	const saved = await request.post(`${base}/documents/article`, { data: { value: "日本語の文書 🌸" } });
	expect(saved.status()).toBe(200);
	const written = await saved.json();
	expect(written.document).toEqual({ value: "日本語の文書 🌸", version: 1 });
	expect(written.pending).toHaveLength(1);
	const eventId = written.pending[0].eventId;

	const failed = await request.post(`${base}/documents/article/publish`, { data: { fault: "before-send" } });
	expect(failed.status()).toBe(503);
	const retained = await (await request.get(`${base}/documents/article`)).json();
	expect(retained.document.version).toBe(1);
	expect(retained.pending[0].eventId).toBe(eventId);
	expect((await (await request.get(`${base}/projections`)).json()).search.documents).toEqual([]);

	expect((await request.post(`${base}/documents/article/publish`)).ok()).toBe(true);
	expect((await (await request.get(`${base}/documents/article`)).json()).pending).toEqual([]);
	expect((await request.post(`${base}/consume/search`)).ok()).toBe(true);
	const indexed = await (await request.get(`${base}/projections?q=日本語`)).json();
	expect(indexed.search.documents).toEqual([{ documentId: "article", value: "日本語の文書 🌸", version: 1 }]);
	expect(indexed.audit.totalUpdates).toBe(0);

	expect((await request.post(`${base}/consume/audit`)).ok()).toBe(true);
	const audited = await (await request.get(`${base}/projections`)).json();
	expect(audited.audit.totalUpdates).toBe(1);
	expect(audited.audit.events[0].eventId).toBe(eventId);
	expect(audited.audit.events[0].value).toBe("日本語の文書 🌸");
});

test("発行後の応答喪失と consumer 再取得が監査を二重計上しない", async ({ request }) => {
	const base = `/api/pipeline/${randomUUID()}`;
	await request.post(`${base}/documents/article`, { data: { value: "one update" } });
	const lost = await request.post(`${base}/documents/article/publish`, { data: { fault: "after-send" } });
	expect(lost.status()).toBe(503);
	expect((await (await request.get(`${base}/documents/article`)).json()).pending).toHaveLength(1);
	expect((await request.post(`${base}/documents/article/publish`)).ok()).toBe(true);

	const stopped = await request.post(`${base}/consume/audit`, { data: { fault: "after-first-effect" } });
	expect(stopped.status()).toBe(503);
	expect((await (await request.get(`${base}/projections`)).json()).audit.totalUpdates).toBe(1);
	const retry = await request.post(`${base}/consume/audit`);
	expect(retry.ok()).toBe(true);
	expect((await retry.json()).records).toBe(2);
	const view = await (await request.get(`${base}/projections`)).json();
	expect(view.audit.totalUpdates).toBe(1);
	expect(view.audit.events).toHaveLength(1);
	expect((await (await request.post(`${base}/consume/audit`)).json()).records).toBe(0);
});

test("新しい版を先に処理しても検索が巻き戻らず、ack 済みログから再構築できる", async ({ request }) => {
	const base = `/api/pipeline/${randomUUID()}`;
	for (const value of ["old", "latest"]) {
		expect((await request.post(`${base}/documents/article`, { data: { value } })).ok()).toBe(true);
	}
	await request.post(`${base}/documents/article/publish`);
	expect((await request.post(`${base}/consume/search`, { data: { reverse: true } })).ok()).toBe(true);
	await request.post(`${base}/consume/audit`);
	const before = await (await request.get(`${base}/projections`)).json();
	expect(before.search.documents).toEqual([{ documentId: "article", value: "latest", version: 2 }]);
	expect(before.audit.totalUpdates).toBe(2);
	expect((await (await request.get(`${base}/projections?q=missing`)).json()).search.documents).toEqual([]);

	expect((await request.post(`${base}/projections/search/reset`)).ok()).toBe(true);
	const cleared = await (await request.get(`${base}/projections`)).json();
	expect(cleared.search.documents).toEqual([]);
	expect(cleared.search.subscription).not.toBe(before.search.subscription);
	expect(cleared.audit.totalUpdates).toBe(2);
	expect((await request.post(`${base}/consume/search`)).ok()).toBe(true);
	const rebuilt = await (await request.get(`${base}/projections`)).json();
	expect(rebuilt.search.documents).toEqual(before.search.documents);
	expect(rebuilt.search.processedEventIds).toHaveLength(2);
});

test("batch の途中で停止しても別 subscription は進み、再処理で全件が一度ずつ反映される", async ({ request }) => {
	const oracle = documentEventOracle();
	const base = `/api/pipeline/${randomUUID()}`;
	for (const value of ["first", "second"]) await request.post(`${base}/documents/article`, { data: { value } });
	await request.post(`${base}/documents/article/publish`);
	expect((await request.post(`${base}/consume/audit`, { data: { fault: "after-first-effect" } })).status()).toBe(503);
	expect((await request.post(`${base}/consume/search`)).ok()).toBe(true);
	const partial = await (await request.get(`${base}/projections`)).json();
	expect(partial.search.documents[0].version).toBe(2);
	expect(partial.audit.totalUpdates).toBe(1);
	expect((await request.post(`${base}/consume/audit`)).ok()).toBe(true);
	const complete = await (await request.get(`${base}/projections`)).json();
	const source = await (await request.get(`${base}/documents/article`)).json();
	expect({ documentVersion: source.document.version, searchVersion: complete.search.documents[0].version,
		auditCount: complete.audit.totalUpdates }, oracle.actions.join(" → ")).toEqual({
		documentVersion: oracle.documentVersion, searchVersion: oracle.searchVersion, auditCount: oracle.auditCount,
	});
	expect(complete.audit.byDocument.article).toBe(2);
});

test("同時保存と同一 worker の同時再取得でもイベント ID と副作用が重複しない", async ({ request }) => {
	const base = `/api/pipeline/${randomUUID()}`;
	const saves = await Promise.all(["first", "second"].map(value => request.post(`${base}/documents/article`, { data: { value } })));
	expect(saves.every(response => response.ok())).toBe(true);
	const written = await Promise.all(saves.map(response => response.json()));
	expect(written.map(body => body.document.version).sort()).toEqual([1, 2]);
	const source = await (await request.get(`${base}/documents/article`)).json();
	expect(new Set(source.pending.map((event: { eventId: string }) => event.eventId)).size).toBe(2);
	await request.post(`${base}/documents/article/publish`);
	const consumers = await Promise.all([request.post(`${base}/consume/audit`), request.post(`${base}/consume/audit`)]);
	expect(consumers.every(response => response.ok())).toBe(true);
	expect((await (await request.get(`${base}/projections`)).json()).audit.totalUpdates).toBe(2);
});

test("画面で保存・発行・検索・監査を別々に進められる", async ({ page }) => {
	await page.goto(`/?project=${randomUUID()}`);
	await expect(page.getByRole("heading", { name: "文書イベントから検索と監査を作る" })).toBeVisible();
	await page.getByLabel("イベント用の文書内容").fill("画面から保存した文書");
	await page.getByRole("button", { name: "文書を保存" }).click();
	await expect(page.getByTestId("pipeline-pending")).toHaveText("1");
	await expect(page.getByTestId("pipeline-audit-count")).toHaveText("0");
	await page.getByRole("button", { name: "イベントを発行" }).click();
	await expect(page.getByTestId("pipeline-pending")).toHaveText("0");
	await page.getByRole("button", { name: "検索を更新" }).click();
	await expect(page.getByTestId("pipeline-search")).toContainText("画面から保存した文書");
	await expect(page.getByTestId("pipeline-audit-count")).toHaveText("0");
	await page.getByRole("button", { name: "監査を更新" }).click();
	await expect(page.getByTestId("pipeline-audit-count")).toHaveText("1");
});

test("不正な API 入力で outbox や subscription を進めない", async ({ request }) => {
	const base = `/api/pipeline/${randomUUID()}`;
	await request.post(`${base}/documents/article`, { data: { value: "valid" } });
	for (const data of [{ value: 1 }, { value: "x".repeat(1001) }]) {
		expect((await request.post(`${base}/documents/article`, { data })).status()).toBe(400);
	}
	expect((await request.post(`${base}/documents/article/publish`, { data: { fault: ["before-send"] } })).status()).toBe(400);
	expect((await request.post(`${base}/consume/search`, { data: { fault: ["after-first-effect"] } })).status()).toBe(400);
	expect((await request.post(`${base}/consume/audit`, { data: { reverse: "true" } })).status()).toBe(400);
	expect((await request.post(`${base}/documents/article/publish`, { data: "{", headers: { "Content-Type": "application/json" } })).status()).toBe(400);
	const source = await (await request.get(`${base}/documents/article`)).json();
	expect(source.document.version).toBe(1);
	expect(source.pending).toHaveLength(1);
	const view = await (await request.get(`${base}/projections`)).json();
	expect(view.search.processedEventIds).toEqual([]);
	expect(view.audit.totalUpdates).toBe(0);
});
