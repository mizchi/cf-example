import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const markdown = resolve(root, "docs/README.md");

function checkLinks(file, pattern) {
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(pattern)) {
		const href = match[1];
		if (/^(?:https?:|mailto:|#|data:)/.test(href)) continue;
		const path = decodeURIComponent(href.split("#", 1)[0]);
		if (!existsSync(resolve(dirname(file), path))) {
			throw new Error(`${file}: missing local link ${href}`);
		}
	}
}

checkLinks(markdown, /!?(?:\[[^\]]*\])\(([^)\s]+)\)/g);
checkLinks(resolve(root, "docs/recovery-patterns.md"), /!?(?:\[[^\]]*\])\(([^)\s]+)\)/g);
console.log("guide links: Markdown guides resolve locally");
