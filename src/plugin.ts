import type { SandboxedPlugin } from "emdash/plugin";
import { handleAdmin } from "./admin.js";

/**
 * Sandboxed plugin entry. The explicit `SandboxedPlugin` annotation gives TypeScript per-hook /
 * per-route inference (`ctx` is `PluginContext` automatically; hook
 * `event` parameters are typed by hook name).
 */
const plugin: SandboxedPlugin = {
	routes: {
		admin: { methods: ["POST"], request: { body: "json", maxBytes: 256 * 1024 }, handler: handleAdmin },
	},
};

export default plugin;
