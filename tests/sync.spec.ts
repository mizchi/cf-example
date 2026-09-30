import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("a Durable Object write returns a higher version", async ({ request }) => {
	const id = randomUUID();
	const path = `/api/documents/${id}`;
	const initial = await request.get(path);
	expect(initial.ok()).toBe(true);
	const before = await initial.json();
	expect(before).toEqual({ value: "", version: 0 });
	expect(initial.headers()["cache-control"]).toContain("max-age");

	const write = await request.post(path, { data: { value: "updated" } });
	expect(write.ok()).toBe(true);
	expect(await write.json()).toMatchObject({ value: "updated", version: 1 });
});

test("concurrent writes receive distinct ordered versions", async ({ request }) => {
	const path = `/api/documents/${randomUUID()}`;
	const responses = await Promise.all([
		request.post(path, { data: { value: "first" } }),
		request.post(path, { data: { value: "second" } }),
	]);
	expect(responses.every((response) => response.ok())).toBe(true);
	const versions = await Promise.all(responses.map(async (response) => (await response.json()).version as number));
	expect(versions.sort()).toEqual([1, 2]);
});

test("a delayed cached GET cannot roll the client back after a write", async ({ page }) => {
	const id = randomUUID();
	const path = `/api/documents/${id}`;
	const oldGetReleased = Promise.withResolvers<void>();
	const oldGetCaptured = Promise.withResolvers<number>();
	let held = false;

	await page.route(`**${path}`, async (route) => {
		if (route.request().method() !== "GET" || held) {
			await route.continue();
			return;
		}
		held = true;
		const response = await route.fetch();
		oldGetCaptured.resolve((await response.json()).version);
		await oldGetReleased.promise;
		await route.fulfill({ response });
	});

	try {
		await page.goto(`/?doc=${id}`);
		const oldVersion = await oldGetCaptured.promise;
		await page.getByLabel("Document value").fill("updated");
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByTestId("document-version")).toHaveText(String(oldVersion + 1));
		await expect(page.getByTestId("document-value")).toHaveText("updated");
		oldGetReleased.resolve();
		await expect(page.getByTestId("document-get-status")).toHaveText("Loaded");
		await expect(page.getByTestId("document-version")).toHaveText(String(oldVersion + 1));
		await expect(page.getByTestId("document-value")).toHaveText("updated");
	} finally {
		oldGetReleased.resolve();
	}
});
