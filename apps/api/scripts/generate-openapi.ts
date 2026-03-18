import fs from "node:fs";
import { createApp } from "../src/app.js";

const app = createApp();
const spec = app.getOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "Nexu API", version: "1.0.0" },
});

const outputPath = new URL("../openapi.json", import.meta.url).pathname;
fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec written to ${outputPath}`);
