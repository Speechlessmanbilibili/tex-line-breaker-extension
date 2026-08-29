import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("wasm", { recursive: true });
copyFileSync("target/wasm32-unknown-unknown/release/tex_line_breaker_core.wasm", "wasm/tex_line_breaker_core.wasm");
