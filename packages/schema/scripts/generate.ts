import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonSchemas, stringifySchema } from "../src/json-schema.ts";

const out = join(import.meta.dirname, "..", "json");
mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas())) {
  writeFileSync(join(out, name), stringifySchema(schema));
  console.log(`wrote json/${name}`);
}
