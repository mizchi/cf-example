import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	use: {
		baseURL: "http://localhost:5173",
		browserName: "chromium",
	},
	webServer: {
		command: "pnpm exec cf dev",
		url: "http://localhost:5173/",
		timeout: 30_000,
		reuseExistingServer: false,
	},
});
