import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "cf-example",
		compatibilityDate: "2026-09-25",
		entrypoint,
		cache: { enabled: true },
		exports: {
			DocumentStore: exports.durableObject({ storage: "sqlite" }),
			ClaimStore: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			WORLD: bindings.text("World"),
			DOCUMENT: bindings.durableObject({ worker: "cf-example", exportName: "DocumentStore" }),
			CLAIM: bindings.durableObject({ worker: "cf-example", exportName: "ClaimStore" }),
		},
	},
});
