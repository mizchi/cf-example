import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { claimOracle } from "./quint-oracle";

test("a non-storage await can double-claim, but an early reservation prevents it", async ({ request }) => {
	for (const mode of ["naive", "safe"] as const) {
		const oracle = claimOracle(mode);
		const path = `/api/claims/${randomUUID()}/${mode}`;
		const responses = await Promise.all([request.post(path), request.post(path)]);
		expect(responses.every((response) => response.ok())).toBe(true);
		const results = await Promise.all(responses.map(async (response) => response.json() as Promise<{ claimed: boolean }>));
		expect(results.filter((result) => result.claimed).length, oracle.actions.join(" → ")).toBe(oracle.accepted);
	}
});
