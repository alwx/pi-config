import {
	type AnyModel,
	type AssistantMessageEventStream,
	type Message,
	type Provider,
	type TranscriptContext,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Profile {
	name: string;
	providers: string[];
}

const CONFIG_PATH = join(getAgentDir(), "multi-profile.json");
const SEPARATOR = ":";

function loadProfiles(): Profile[] {
	if (!existsSync(CONFIG_PATH)) return [];
	return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Profile[];
}

function saveProfiles(profiles: Profile[]): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(profiles, null, 2)}\n`);
}

// Ambient-only providers (Bedrock, Vertex) cannot hold a separate stored credential per profile.
function loginableProviders(): Provider[] {
	return builtinProviders().filter((p) => p.auth.oauth || p.auth.apiKey?.login);
}

function withProvider<T extends AnyModel | Message>(item: T, from: string, to: string): T {
	return "provider" in item && item.provider === from ? { ...item, provider: to } : item;
}

function relabelStream(source: AssistantMessageEventStream, from: string, to: string): AssistantMessageEventStream {
	const target = createAssistantMessageEventStream();
	(async () => {
		for await (const event of source) {
			const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
			if (message.provider === from) message.provider = to;
			target.push(event);
		}
		target.end();
	})();
	return target;
}

// The wrapper owns a separate id, so Pi keeps its credential under that id in auth.json.
// Requests reach the built-in API under the base id because API code branches on model.provider.
function profileProvider(base: Provider, profile: string): Provider {
	const id = `${base.id}${SEPARATOR}${profile}`;
	const toBase = <T extends AnyModel | Message>(item: T) => withProvider(item, id, base.id);
	const toProfile = <T extends AnyModel | Message>(item: T) => withProvider(item, base.id, id);
	const baseContext = (context: TranscriptContext) => ({ ...context, messages: context.messages.map(toBase) }) as TranscriptContext;
	const apiKey = base.auth.apiKey;

	return {
		id,
		name: `${base.name} (${profile})`,
		baseUrl: base.baseUrl,
		headers: base.headers,
		auth: {
			oauth: base.auth.oauth,
			apiKey: apiKey && {
				name: apiKey.name,
				login: apiKey.login && ((interaction) => apiKey.login!(interaction)),
				check: apiKey.check && ((input) => (input.credential ? apiKey.check!(input) : Promise.resolve(undefined))),
				resolve: (input) => (input.credential ? apiKey.resolve(input) : Promise.resolve(undefined)),
			},
		},
		getModels: () => base.getModels().map(toProfile),
		getAllModels: base.getAllModels && (() => base.getAllModels!().map(toProfile)),
		refreshModels: base.refreshModels && ((context) => base.refreshModels!(context)),
		filterModels:
			base.filterModels && ((models, credential) => base.filterModels!(models.map(toBase), credential).map(toProfile)),
		filterAllModels:
			base.filterAllModels &&
			((models, credential) => base.filterAllModels!(models.map(toBase), credential).map(toProfile)),
		stream: (model, context, options) =>
			relabelStream(base.stream(toBase(model), baseContext(context), options), base.id, id),
		streamSimple: (model, context, options) =>
			relabelStream(base.streamSimple(toBase(model), baseContext(context), options), base.id, id),
		fetchDeferred:
			base.fetchDeferred &&
			((model, handle, options) => relabelStream(base.fetchDeferred!(toBase(model), handle, options), base.id, id)),
		cancelDeferred: base.cancelDeferred && ((model, handle, options) => base.cancelDeferred!(toBase(model), handle, options)),
		generateImages: base.generateImages && ((model, context, options) => base.generateImages!(toBase(model), context, options)),
		classify: base.classify && ((model, context, options) => base.classify!(toBase(model), context, options)),
	};
}

function profileOf(providerId: string | undefined): string | undefined {
	const index = providerId?.indexOf(SEPARATOR) ?? -1;
	return index === -1 ? undefined : providerId!.slice(index + 1);
}

function updateStatus(ctx: ExtensionContext, providerId: string | undefined): void {
	const profile = profileOf(providerId);
	ctx.ui.setStatus("multi-profile", profile && ctx.ui.theme.fg("accent", `profile: ${profile}`));
}

export default function (pi: ExtensionAPI) {
	const bases = new Map(loginableProviders().map((p) => [p.id, p]));
	const profiles = loadProfiles();

	for (const profile of profiles) {
		for (const providerId of profile.providers) {
			const base = bases.get(providerId);
			if (base) pi.registerProvider(profileProvider(base, profile.name));
		}
	}

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx, ctx.model?.provider));
	pi.on("model_select", async (event, ctx) => updateStatus(ctx, event.model.provider));

	async function pickProviders(ctx: ExtensionContext, name: string): Promise<string[]> {
		const selected: string[] = [];
		const done = "Done";
		while (true) {
			const remaining = [...bases.keys()].filter((id) => !selected.includes(id));
			const label = selected.length ? `Providers for "${name}" (${selected.join(", ")})` : `Providers for "${name}"`;
			const choice = await ctx.ui.select(label, selected.length ? [done, ...remaining] : remaining);
			if (!choice || choice === done) return selected;
			selected.push(choice);
		}
	}

	pi.registerCommand("profile", {
		description: "Manage account profiles: /profile list | add <name> [providers...] | remove <name>",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				return ["list", "add", "remove"].filter((s) => s.startsWith(parts[0])).map((s) => ({ value: s, label: s }));
			}
			if (parts[0] === "remove" && parts.length === 2) {
				return loadProfiles()
					.filter((p) => p.name.startsWith(parts[1]))
					.map((p) => ({ value: `remove ${p.name}`, label: p.name }));
			}
			if (parts[0] === "add" && parts.length > 2) {
				const head = parts.slice(0, -1).join(" ");
				return [...bases.keys()]
					.filter((id) => id.startsWith(parts.at(-1)!) && !parts.includes(id))
					.map((id) => ({ value: `${head} ${id}`, label: id }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const [subcommand = "list", name, ...providerArgs] = args.trim().split(/\s+/).filter(Boolean);
			const current = loadProfiles();

			if (subcommand === "list") {
				const lines = current.map((p) => `${p.name}: ${p.providers.map((id) => `${id}${SEPARATOR}${p.name}`).join(", ")}`);
				ctx.ui.notify(lines.length ? lines.join("\n") : "No profiles. Use /profile add <name>.", "info");
				return;
			}

			if (subcommand === "add") {
				if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
					ctx.ui.notify("Usage: /profile add <name> [providers...]. The name can use letters, digits, _ and -.", "error");
					return;
				}
				if (current.some((p) => p.name === name)) {
					ctx.ui.notify(`Profile "${name}" exists.`, "error");
					return;
				}
				const unknown = providerArgs.filter((id) => !bases.has(id));
				if (unknown.length) {
					ctx.ui.notify(`Unknown or ambient-only providers: ${unknown.join(", ")}`, "error");
					return;
				}
				const providers = providerArgs.length ? providerArgs : await pickProviders(ctx, name);
				if (!providers.length) return;
				saveProfiles([...current, { name, providers }]);
				ctx.ui.notify(`Added "${name}". Run /login and pick ${providers.map((id) => `${bases.get(id)!.name} (${name})`).join(", ")}.`, "info");
				await ctx.reload();
				return;
			}

			if (subcommand === "remove") {
				if (!current.some((p) => p.name === name)) {
					ctx.ui.notify(`Profile "${name ?? ""}" not found.`, "error");
					return;
				}
				const ok = await ctx.ui.confirm(
					`Remove profile "${name}"?`,
					"Credentials stay in auth.json. To delete them, cancel and run /logout for each profile provider first.",
				);
				if (!ok) return;
				saveProfiles(current.filter((p) => p.name !== name));
				await ctx.reload();
				return;
			}

			ctx.ui.notify("Usage: /profile list | add <name> [providers...] | remove <name>", "error");
		},
	});
}
