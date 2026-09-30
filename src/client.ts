import type { HelloResponse } from "./contract";
import "./style.css";
import { mountDocument } from "./document-client";

const output = document.querySelector<HTMLOutputElement>("#message");

if (!output) {
	throw new Error("Missing greeting output");
}

async function loadGreeting(): Promise<string> {
	const response = await fetch("/api/hello");
	if (!response.ok) {
		throw new Error(`API request failed: ${response.status}`);
	}

	const data: unknown = await response.json();
	if (!isHelloResponse(data)) {
		throw new Error("Invalid API response");
	}
	return data.message;
}

function isHelloResponse(value: unknown): value is HelloResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"message" in value &&
		typeof value.message === "string"
	);
}

loadGreeting().then(
	(message) => {
		output.textContent = message;
	},
	() => {
		output.textContent = "Could not load the Worker response.";
	},
);

mountDocument();
