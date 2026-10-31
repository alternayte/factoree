import { defineConfig } from "@hey-api/openapi-ts";

// The API writes ../api/openapi.json with @fastify/swagger. Prettier formats the output, so a
// second run over the same document writes the same bytes.
export default defineConfig({
  input: "../api/openapi.json",
  output: { path: "src/api", postProcess: ["prettier"] },
  plugins: [
    "@hey-api/client-fetch",
    "@hey-api/typescript",
    "@hey-api/sdk",
    {
      name: "@tanstack/react-query",
      queryOptions: true,
      mutationOptions: true,
      queryKeys: true,
    },
  ],
});
