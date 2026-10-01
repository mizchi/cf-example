import { bindings, defineConfig, exports } from "cf/config";
import { env as configEnv } from "node:process";
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
			EventDocumentStore: exports.durableObject({ storage: "sqlite" }),
			EventProjectionStore: exports.durableObject({ storage: "sqlite" }),
			LocalK2Stream: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			WORLD: bindings.text("World"),
			DOCUMENT: bindings.durableObject({ worker: "cf-example", exportName: "DocumentStore" }),
			CLAIM: bindings.durableObject({ worker: "cf-example", exportName: "ClaimStore" }),
			EVENT_DOCUMENT: bindings.durableObject({ worker: "cf-example", exportName: "EventDocumentStore" }),
			EVENT_PROJECTION: bindings.durableObject({ worker: "cf-example", exportName: "EventProjectionStore" }),
			EVENT_STREAM: bindings.durableObject({ worker: "cf-example", exportName: "LocalK2Stream" }),
			K2_ENDPOINT: bindings.text(configEnv.K2_ENDPOINT ?? ""),
			K2_API_TOKEN: configEnv.K2_ENDPOINT ? bindings.secret() : bindings.text(""),
		},
	},
});
