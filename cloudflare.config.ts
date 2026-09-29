import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "cf-example",
		compatibilityDate: "2026-09-25",
		entrypoint,
		env: {
			WORLD: bindings.text("World"),
		},
	},
});
