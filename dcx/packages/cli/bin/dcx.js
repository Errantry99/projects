#!/usr/bin/env node
// The `dcx` command. The workspace ships TypeScript sources, so the CLI runs them through tsx.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
