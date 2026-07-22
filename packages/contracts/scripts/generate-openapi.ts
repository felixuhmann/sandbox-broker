/**
 * Writes `openapi/openapi.json`, or with `--check` fails when the committed
 * document has drifted from the Zod contract.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "../src/openapi.js";

const repoRoot = new URL("../../../", import.meta.url);
const outputPath = fileURLToPath(new URL("openapi/openapi.json", repoRoot));
const rootPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL("package.json", repoRoot)), "utf8"),
) as { version: string };

const document = `${JSON.stringify(buildOpenApiDocument(rootPackage.version), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current: string;
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    console.error(`openapi: ${outputPath} is missing. Run \`pnpm openapi:generate\`.`);
    process.exit(1);
  }
  if (current !== document) {
    console.error("openapi: committed document differs from the Zod contract.");
    console.error("Run `pnpm openapi:generate` and commit the result.");
    process.exit(1);
  }
  console.log("openapi: committed document is up to date.");
} else {
  writeFileSync(outputPath, document);
  console.log(`openapi: wrote ${outputPath}`);
}
