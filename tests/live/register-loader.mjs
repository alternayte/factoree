// Registers `path-alias-loader.mjs` before Node loads the live acceptance entry point. Load
// this file with `node --import`. See `path-alias-loader.mjs` for why it exists.
import { register } from "node:module";

register("./path-alias-loader.mjs", import.meta.url);
