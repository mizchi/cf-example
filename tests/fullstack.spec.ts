import { expect, test } from "@playwright/test";

test("the frontend displays the response from the Worker API", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "cf + Vite" })).toBeVisible();
	await expect(page.locator("#message")).toHaveText("Hello World!");
});

test("the Worker serves JSON from the same origin", async ({ request }) => {
	const response = await request.get("/api/hello");
	expect(response.ok()).toBe(true);
	expect(response.headers()["content-type"]).toContain("application/json");
	expect(await response.json()).toEqual({ message: "Hello World!" });
});
