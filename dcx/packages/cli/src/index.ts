// @dcx/cli: the `dcx` command (07 §4.7) and the seams it closes between the packages.
export * from "./backends.js";
export * from "./config.js";
export * from "./context.js";
export * from "./judge-service.js";
export * from "./llm-fixture.js";
export { buildProgram, main, runCli } from "./main.js";
export * from "./project.js";
