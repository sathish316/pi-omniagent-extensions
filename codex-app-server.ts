/**
 * Codex App Server provider extension for pi.
 *
 * Bridges pi to OpenAI Codex running in app-server mode
 * (`codex app-server`, stdio JSON-RPC transport). Each Codex model is
 * registered as a pi provider model, so they appear in pi's `/model` picker
 * labelled with "[codex-app-server]". Selecting one routes the conversation through
 * Codex, which works directly in your workspace.
 *
 * Modeled on the cursor-acp.ts ACP bridge.
 *
 * Config (all optional, via env):
 *   CODEX_BIN                 path to codex binary (default: "codex")
 *   CODEX_APPSERVER_ARGS      extra args after `app-server` (space separated)
 *   CODEX_APPSERVER_MODEL     restrict to a single model id
 *   CODEX_APPSERVER_APPROVAL  never | on-request | on-failure | untrusted |
 *                             granular (default: on-request; approvals are
 *                             auto-accepted by the bridge). Note: org/cloud
 *                             requirements may force on-request.
 *   CODEX_APPSERVER_SANDBOX   read-only | workspace-write | danger-full-access
 *                             (default: workspace-write)
 *   CODEX_APPSERVER_EXPERIMENTAL=true  enable experimental app-server APIs
 *   CODEX_APPSERVER_DEBUG=true         log JSON-RPC traffic to stderr
 *
 * Docs: https://developers.openai.com/codex/app-server
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { acpProviderGate, type AcpRefresher } from "./acp-lib/config.ts";
import { isModelCacheStale, readModelCache, writeModelCache } from "./acp-lib/model-cache.ts";

const PROVIDER = "codex-app-server";
const API = "codex-app-server";
const CODEX_COMMAND = process.env.CODEX_BIN ?? "codex";
const CODEX_ARGS = ["app-server", ...(process.env.CODEX_APPSERVER_ARGS ?? "").split(/\s+/).filter(Boolean)];
const STARTUP_TIMEOUT_MS = Number(process.env.CODEX_APPSERVER_STARTUP_TIMEOUT_MS ?? 30_000);
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_APPSERVER_REQUEST_TIMEOUT_MS ?? 15 * 60_000);
const APPROVAL_POLICY = process.env.CODEX_APPSERVER_APPROVAL ?? "on-request";
const SANDBOX_MODE = process.env.CODEX_APPSERVER_SANDBOX ?? "workspace-write";
const EXPERIMENTAL = process.env.CODEX_APPSERVER_EXPERIMENTAL === "true";
const DEBUG = process.env.CODEX_APPSERVER_DEBUG === "true";

type JsonRpcMessage = {
	jsonrpc?: "2.0";
	id?: string | number | null;
	method?: string;
	params?: any;
	result?: any;
	error?: any;
};

type CodexModelInfo = {
	id: string;
	displayName: string;
	supportedReasoningEfforts: string[];
	contextWindow: number;
	input: ("text" | "image")[];
};

type CodexModelVariant = {
	id: string;
	modelId: string;
	displayName: string;
	effort: string | null;
	contextWindow: number;
	input: ("text" | "image")[];
};

/**
 * JSON-RPC 2.0 client over `codex app-server` stdio (newline-delimited JSON).
 * Handles request/response correlation, notifications, and server-initiated
 * requests (approvals).
 */
class CodexAppServer {
	private proc: ChildProcessWithoutNullStreams;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	private closed = false;
	private initialized = false;

	constructor(
		private cwd: string,
		private onNotification?: (message: JsonRpcMessage) => void,
	) {
		this.proc = spawn(CODEX_COMMAND, CODEX_ARGS, { cwd, env: process.env, stdio: "pipe" });
		this.proc.stdout.setEncoding("utf8");
		this.proc.stderr.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		this.proc.stderr.on("data", (chunk: string) => {
			if (DEBUG) process.stderr.write(`[codex-app-server stderr] ${chunk}`);
		});
		this.proc.on("exit", (code, signal) => {
			this.closed = true;
			const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(error);
			}
			this.pending.clear();
		});
	}

	isClosed(): boolean {
		return this.closed;
	}

	async initialize(): Promise<any> {
		if (this.initialized) return;
		const result = await this.request(
			"initialize",
			{
				clientInfo: { name: "pi_codex_app_server", title: "pi", version: "0.1.0" },
				capabilities: EXPERIMENTAL ? { experimentalApi: true } : undefined,
			},
			STARTUP_TIMEOUT_MS,
		);
		this.notify("initialized", {});
		this.initialized = true;
		return result;
	}

	async startThread(params: Record<string, unknown>): Promise<string> {
		const res = await this.request("thread/start", params, STARTUP_TIMEOUT_MS);
		return res.thread.id as string;
	}

	async listModels(): Promise<any[]> {
		const res = await this.request("model/list", { includeHidden: false }, STARTUP_TIMEOUT_MS);
		return res?.data ?? [];
	}

	async interrupt(threadId: string, turnId: string): Promise<void> {
		await this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
	}

	async request(method: string, params?: any, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
		if (this.closed) throw new Error("codex app-server process is closed");
		const id = this.nextId++;
		const promise = new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`codex app-server request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		this.write({ method, id, params });
		return promise;
	}

	notify(method: string, params?: any): void {
		this.write({ method, params });
	}

	dispose(): void {
		if (!this.proc.killed) this.proc.kill();
	}

	private write(message: JsonRpcMessage): void {
		if (DEBUG) process.stderr.write(`[codex-app-server ->] ${JSON.stringify(message)}\n`);
		try {
			this.proc.stdin.write(`${JSON.stringify(message)}\n`);
		} catch {
			/* process gone */
		}
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			try {
				const message = JSON.parse(line) as JsonRpcMessage;
				if (DEBUG) process.stderr.write(`[codex-app-server <-] ${JSON.stringify(message)}\n`);
				void this.handleMessage(message);
			} catch (error) {
				if (DEBUG) process.stderr.write(`[codex-app-server parse error] ${String(error)} for ${line}\n`);
			}
		}
	}

	private async handleMessage(message: JsonRpcMessage): Promise<void> {
		// Server-initiated request (has both method and id) -> approvals/input.
		if (message.id != null && message.method) {
			await this.handleServerRequest(message);
			return;
		}
		// Response to one of our requests.
		if (message.id != null) {
			const id = Number(message.id);
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			if (message.error) {
				pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
			} else pending.resolve(message.result);
			return;
		}
		// Notification.
		if (message.method) this.onNotification?.(message);
	}

	private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
		const method = message.method!;
		let result: any = {};
		// Auto-accept approval requests (the bridge runs with the configured
		// approval policy; with "never" these should not fire at all).
		if (
			method === "item/commandExecution/requestApproval" ||
			method === "item/fileChange/requestApproval"
		) {
			result = { decision: "accept" };
		} else if (method === "tool/requestUserInput") {
			result = { answers: [""] };
		}
		this.write({ id: message.id!, result });
	}
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textOfContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content ?? "");
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "image") return `[image: ${block.mimeType ?? "unknown"}]`;
			return `[${block.type}]`;
		})
		.join("\n");
}

function bridgeNote(): string {
	return (
		"# Bridge note\n" +
		"You are OpenAI Codex running through the Codex app-server, called from Pi. " +
		"Answer the latest user request. Use your own tools to inspect or modify files in the workspace."
	);
}

function formatMessages(messages: Context["messages"]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") parts.push(`User:\n${textOfContent(message.content)}`);
		else if (message.role === "assistant") {
			const text = message.content
				.map((block: any) =>
					block.type === "text" ? block.text : block.type === "thinking" ? "" : `[tool call: ${block.name}]`,
				)
				.filter(Boolean)
				.join("\n");
			if (text.trim()) parts.push(`Assistant:\n${text}`);
		} else if (message.role === "toolResult") {
			parts.push(`Tool result (${message.toolName}):\n${textOfContent(message.content)}`);
		}
	}
	return parts.join("\n\n");
}

function bootstrapPrompt(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt) parts.push(`# Pi system prompt\n${context.systemPrompt}`);
	parts.push(bridgeNote(), "# Conversation", formatMessages(context.messages));
	return parts.join("\n\n");
}

function incrementalPrompt(
	context: Context,
	sentMessageCount: number,
): { text: string; newSentCount: number } {
	const messages = context.messages;
	if (sentMessageCount === 0 || messages.length < sentMessageCount) {
		return { text: bootstrapPrompt(context), newSentCount: messages.length };
	}
	const delta = messages.slice(sentMessageCount);
	if (delta.length === 0) return { text: "Continue.", newSentCount: messages.length };
	return { text: formatMessages(delta), newSentCount: messages.length };
}

/** Manages a single Codex thread bound to a pi session. */
class CodexBridge {
	private server: CodexAppServer | null = null;
	private threadId: string | null = null;
	private currentModelId: string | null = null;
	private currentEffort: string | null = null;
	private activeTurnId: string | null = null;
	private cwd: string | null = null;
	private piSessionKey: string | null = null;
	private sentMessageCount = 0;
	private promptChain: Promise<void> = Promise.resolve();
	private notificationHandler: ((message: JsonRpcMessage) => void) | null = null;

	setNotificationHandler(handler: ((message: JsonRpcMessage) => void) | null): void {
		this.notificationHandler = handler;
	}

	private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.promptChain.then(fn, fn);
		this.promptChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async ensureThread(piSessionKey: string, cwd: string, modelId: string): Promise<void> {
		if (this.server?.isClosed()) {
			this.server = null;
			this.threadId = null;
		}
		if (this.piSessionKey !== piSessionKey || this.cwd !== cwd) {
			await this.dispose();
			this.piSessionKey = piSessionKey;
			this.cwd = cwd;
			this.sentMessageCount = 0;
		}
		if (!this.server) {
			this.server = new CodexAppServer(cwd, (message) => this.notificationHandler?.(message));
			await this.server.initialize();
		}
		if (!this.threadId) {
			this.threadId = await this.server.startThread({
				model: modelId,
				cwd,
				approvalPolicy: APPROVAL_POLICY,
				sandbox: SANDBOX_MODE,
				serviceName: "pi_codex_app_server",
			});
			this.currentModelId = modelId;
			this.sentMessageCount = 0;
		}
	}

	async resetThread(): Promise<void> {
		return this.runExclusive(async () => {
			if (!this.server || this.server.isClosed() || !this.cwd) return;
			this.threadId = await this.server.startThread({
				model: this.currentModelId ?? undefined,
				cwd: this.cwd,
				approvalPolicy: APPROVAL_POLICY,
				sandbox: SANDBOX_MODE,
				serviceName: "pi_codex_app_server",
			});
			this.sentMessageCount = 0;
		});
	}

	/** Run a turn, streaming events through onEvent. Resolves on turn/completed. */
	async prompt(
		context: Context,
		modelId: string,
		effort: string | null,
		piSessionKey: string,
		cwd: string,
		onEvent: (message: JsonRpcMessage) => void,
		signal?: AbortSignal,
	): Promise<{ stopReason: string }> {
		return this.runExclusive(async () => {
			await this.ensureThread(piSessionKey, cwd, modelId);
			const server = this.server!;
			const threadId = this.threadId!;
			const { text, newSentCount } = incrementalPrompt(context, this.sentMessageCount);
			this.sentMessageCount = newSentCount;

			return new Promise<{ stopReason: string }>((resolve, reject) => {
				let done = false;
				const finish = (value: { stopReason: string }) => {
					if (done) return;
					done = true;
					this.setNotificationHandler(null);
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				};
				const fail = (err: Error) => {
					if (done) return;
					done = true;
					this.setNotificationHandler(null);
					signal?.removeEventListener("abort", onAbort);
					reject(err);
				};
				const onAbort = () => {
					if (this.activeTurnId) void server.interrupt(threadId, this.activeTurnId);
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				this.setNotificationHandler((message) => {
					const params = message.params ?? {};
					const pThread = params.threadId ?? params.turn?.threadId;
					if (pThread && pThread !== threadId) return;
					if (message.method === "turn/started") {
						this.activeTurnId = params.turn?.id ?? this.activeTurnId;
					}
					if (params.item?.turnId) this.activeTurnId = params.item.turnId;
					onEvent(message);
					if (message.method === "turn/completed") {
						const status = params.turn?.status ?? "completed";
						this.activeTurnId = null;
						finish({ stopReason: status === "interrupted" ? "aborted" : "stop" });
					}
				});

				server
					.request("turn/start", {
						threadId,
						input: [{ type: "text", text }],
						model: modelId,
						effort,
						approvalPolicy: APPROVAL_POLICY,
					})
					.then(() => {
						this.currentModelId = modelId;
						this.currentEffort = effort;
					})
					.catch(fail);
			});
		});
	}

	getStatus() {
		return {
			connected: this.server != null && !this.server.isClosed(),
			threadId: this.threadId,
			currentModelId: this.currentModelId,
			currentEffort: this.currentEffort,
			sentMessageCount: this.sentMessageCount,
			piSessionKey: this.piSessionKey,
			cwd: this.cwd,
		};
	}

	async dispose(): Promise<void> {
		this.server?.dispose();
		this.server = null;
		this.threadId = null;
		this.currentModelId = null;
		this.currentEffort = null;
		this.activeTurnId = null;
		this.cwd = null;
		this.piSessionKey = null;
		this.sentMessageCount = 0;
	}
}

const bridge = new CodexBridge();
const modelCatalog = new Map<string, CodexModelVariant>();

let boundPiSessionKey: string | undefined;
let boundCwd = process.cwd();

async function discoverCodexModels(): Promise<CodexModelInfo[]> {
	const server = new CodexAppServer(process.cwd());
	try {
		await server.initialize();
		const raw = await server.listModels();
		const only = process.env.CODEX_APPSERVER_MODEL;
		const mapped: CodexModelInfo[] = raw
			.filter((m: any) => !only || m.id === only)
			.map((m: any) => ({
				id: m.id ?? m.model,
				displayName: m.displayName ?? m.id ?? m.model,
				supportedReasoningEfforts: Array.isArray(m.supportedReasoningEfforts)
					? m.supportedReasoningEfforts
							.map((option: any) =>
								typeof option === "string" ? option : option?.reasoningEffort,
							)
							.filter((effort: unknown): effort is string => typeof effort === "string" && effort.length > 0)
					: [],
				contextWindow: Number(m.contextWindow ?? 256_000),
				input: Array.isArray(m.inputModalities)
					? (m.inputModalities.filter((i: string) => i === "text" || i === "image") as ("text" | "image")[])
					: ["text", "image"],
			}))
			.filter((m: CodexModelInfo) => Boolean(m.id));
		return mapped.length > 0 ? mapped : [];
	} finally {
		server.dispose();
	}
}

function virtualModelBaseId(modelId: string): string {
	const match = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(modelId);
	if (!match?.[2]) return modelId;
	return `gpt-${match[2]}-${match[1]}`;
}

function createModelVariants(models: CodexModelInfo[]): CodexModelVariant[] {
	const variants = models.flatMap((model) => {
		if (model.supportedReasoningEfforts.length === 0) {
			return [{ ...model, modelId: model.id, effort: null }];
		}

		const baseId = virtualModelBaseId(model.id);
		return model.supportedReasoningEfforts.map((effort) => ({
			id: `${baseId}-${effort}`,
			modelId: model.id,
			displayName: `${model.displayName} (${effort})`,
			effort,
			contextWindow: model.contextWindow,
			input: model.input,
		}));
	});

	const ids = new Set<string>();
	for (const variant of variants) {
		if (ids.has(variant.id)) throw new Error(`Duplicate virtual Codex model id: ${variant.id}`);
		ids.add(variant.id);
	}
	return variants;
}

function streamCodexProvider(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: API,
		provider: PROVIDER,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		let textIndex: number | undefined;
		let textStarted = false;
		let text = "";
		let thinkingIndex: number | undefined;
		let thinkingStarted = false;
		let thinking = "";

		const endThinking = () => {
			if (thinkingStarted) {
				stream.push({ type: "thinking_end", contentIndex: thinkingIndex!, content: thinking, partial: output });
				thinkingStarted = false;
			}
		};
		const appendText = (delta: string) => {
			if (!delta) return;
			endThinking();
			if (!textStarted) {
				textIndex = output.content.length;
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
				textStarted = true;
			}
			text += delta;
			(output.content[textIndex!] as any).text = text;
			stream.push({ type: "text_delta", contentIndex: textIndex!, delta, partial: output });
		};
		const appendThinking = (delta: string) => {
			if (!delta) return;
			if (!thinkingStarted) {
				thinkingIndex = output.content.length;
				output.content.push({ type: "thinking", thinking: "" });
				stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
				thinkingStarted = true;
				thinking = "";
			}
			thinking += delta;
			(output.content[thinkingIndex!] as any).thinking = thinking;
			stream.push({ type: "thinking_delta", contentIndex: thinkingIndex!, delta, partial: output });
		};

		const onEvent = (message: JsonRpcMessage) => {
			const params = message.params ?? {};
			switch (message.method) {
				case "item/agentMessage/delta":
					appendText(params.delta ?? params.text ?? "");
					break;
				case "item/reasoning/summaryTextDelta":
					appendThinking(params.delta ?? params.text ?? "");
					break;
				case "item/started": {
					const item = params.item;
					if (item?.type === "commandExecution") {
						appendText(`\n\n$ ${formatCommand(item.command)}\n`);
					} else if (item?.type === "fileChange") {
						const files = (item.changes ?? []).map((c: any) => c.path).filter(Boolean).join(", ");
						if (files) appendText(`\n\n[edit ${files}]\n`);
					}
					break;
				}
				case "item/completed": {
					const item = params.item;
					if (item?.type === "agentMessage" && typeof item.text === "string" && !textStarted) {
						appendText(item.text);
					}
					break;
				}
				case "error":
					appendText(`\n\n[codex error] ${params?.error?.message ?? "unknown"}\n`);
					break;
			}
		};

		try {
			const variant = modelCatalog.get(model.id);
			if (!variant) throw new Error(`Unknown virtual Codex model id: ${model.id}`);
			stream.push({ type: "start", partial: output });
			const piSessionKey = boundPiSessionKey ?? `ephemeral:${boundCwd}`;
			const result = await bridge.prompt(
				context,
				variant.modelId,
				variant.effort,
				piSessionKey,
				boundCwd,
				onEvent,
				options?.signal,
			);
			output.stopReason = result.stopReason as "stop" | "aborted";

			endThinking();
			if (!textStarted) appendText("");
			stream.push({ type: "text_end", contentIndex: textIndex!, content: text, partial: output });
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: output });
			stream.end(output);
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			endThinking();
			if (textStarted) stream.push({ type: "text_end", contentIndex: textIndex!, content: text, partial: output });
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end(output);
		}
	})();

	return stream;
}

function formatCommand(command: unknown): string {
	if (Array.isArray(command)) return command.join(" ");
	if (typeof command === "string") return command;
	return "command";
}

const CACHE_KEY = "codex-app-server";

/** Revalidate a cached model list; null on any shape drift means "cache miss". */
function reviveCachedModels(raw: unknown): CodexModelInfo[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: CodexModelInfo[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") return null;
		const entry = item as Record<string, unknown>;
		if (typeof entry.id !== "string" || typeof entry.displayName !== "string") return null;
		if (!Array.isArray(entry.supportedReasoningEfforts) || !Array.isArray(entry.input)) return null;
		out.push({
			id: entry.id,
			displayName: entry.displayName,
			supportedReasoningEfforts: entry.supportedReasoningEfforts.filter(
				(e): e is string => typeof e === "string",
			),
			contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 200_000,
			input: entry.input.filter((i): i is "text" | "image" => i === "text" || i === "image"),
		});
	}
	return out;
}

function providerDefinition(variants: CodexModelVariant[]) {
	return {
		name: "Codex (app-server)",
		baseUrl: "stdio://codex/app-server",
		apiKey: "codex-app-server",
		api: API,
		streamSimple: streamCodexProvider,
		models: variants.map((variant) => ({
			id: variant.id,
			name: `${variant.displayName} [codex-app-server]`,
			// Effort is fixed by the virtual model; Pi's separate thinking selector
			// must not override it.
			reasoning: false,
			input: variant.input,
			contextWindow: variant.contextWindow,
			maxTokens: 32_768,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	};
}

function sameVariantIds(a: CodexModelVariant[], b: CodexModelVariant[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((variant, index) => variant.id === b[index].id);
}

export default async function codexAppServerExtension(pi: ExtensionAPI) {
	const gate = acpProviderGate(pi, "codex");
	if (!gate.enabled) return;

	const cached = readModelCache<unknown>(CACHE_KEY);
	const cachedModels = cached ? reviveCachedModels(cached.models) : null;
	let models: CodexModelInfo[];
	let source: string;
	if (cachedModels) {
		models = cachedModels;
		source = "cache";
	} else {
		// First run (or wiped cache): pay the one-time discovery cost so the model
		// picker is real from the start; every later start is a cache hit.
		source = "discovered";
		try {
			models = await discoverCodexModels();
		} catch (error) {
			models = [];
			source = "fallback";
			console.error(
					`[codex-app-server] failed to discover Codex models: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			gate.failed(error);
		}
		if (models.length > 0) writeModelCache(CACHE_KEY, models);
	}
	if (models.length === 0) {
		console.error("[codex-app-server] no Codex models discovered; provider not registered.");
		gate.failed(new Error("no Codex models discovered"));
		return;
	}

	let variants = createModelVariants(models);
	for (const variant of variants) modelCatalog.set(variant.id, variant);

	pi.registerProvider(PROVIDER, providerDefinition(variants));
	gate.loaded(variants.length, source);

	let refreshInFlight: Promise<void> | null = null;

	const refresh: AcpRefresher = async ({ force, notify }) => {
		const entry = readModelCache<unknown>(CACHE_KEY);
		if (!force && entry && !isModelCacheStale(entry)) return { changed: false, models: variants.length };

		const discovered = await discoverCodexModels();
		if (discovered.length === 0) throw new Error("no Codex models discovered");
		const discoveredVariants = createModelVariants(discovered);
		writeModelCache(CACHE_KEY, discovered);
		const changed = !sameVariantIds(discoveredVariants, variants);
		if (changed) {
			// Swap the registered list live; registerProvider after the initial load
			// phase takes effect immediately, so no /reload is needed.
			pi.unregisterProvider(PROVIDER);
			pi.registerProvider(PROVIDER, providerDefinition(discoveredVariants));
			notify?.(`codex-app-server: model list refreshed — ${discoveredVariants.length} models`, "info");
		}
		variants = discoveredVariants;
		modelCatalog.clear();
		for (const variant of variants) modelCatalog.set(variant.id, variant);
		return { changed, models: variants.length };
	};

	function refreshInBackground(force: boolean, notify?: Parameters<AcpRefresher>[0]["notify"]): void {
		if (refreshInFlight) return;
		refreshInFlight = (async () => {
			try {
				await refresh({ force, notify });
			} catch (error) {
				const message = `codex-app-server: model refresh failed: ${
					error instanceof Error ? error.message : String(error)
				}`;
				console.error(`[codex-app-server] ${message}`);
				notify?.(message, "error");
			}
		})().finally(() => {
			refreshInFlight = null;
		});
	}

	gate.setRefresher(refresh);

	pi.on("session_start", async (_event, ctx) => {
		boundPiSessionKey = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		boundCwd = ctx.sessionManager.getCwd();
		// A stale (or missing) cache refreshes in the background; startup never waits for it.
		const entry = readModelCache<unknown>(CACHE_KEY);
		if (!entry || isModelCacheStale(entry)) {
			refreshInBackground(entry == null, (message, level) => ctx.ui.notify(message, level));
		}
	});

	pi.on("session_shutdown", async () => {
		await bridge.dispose();
	});

	pi.on("session_compact", async () => {
		await bridge.resetThread();
	});

	pi.registerCommand("codex-status", {
		description: "Show Codex app-server bridge status",
		handler: async (_args, ctx) => {
			const s = bridge.getStatus();
			const lines = [
				`connected: ${s.connected ? "yes" : "no"}`,
				`thread: ${s.threadId ?? "(none)"}`,
				`current model: ${s.currentModelId ?? "(none)"}`,
				`current effort: ${s.currentEffort ?? "(default)"}`,
				`messages sent: ${s.sentMessageCount}`,
				`approval policy: ${APPROVAL_POLICY}`,
				`sandbox: ${SANDBOX_MODE}`,
				`source models: ${models.length}`,
				`virtual models: ${variants.length}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("codex-reset", {
		description: "Start a new Codex thread (keeps the same Pi session)",
		handler: async (_args, ctx) => {
			await bridge.resetThread();
			ctx.ui.notify("Codex thread reset. Next prompt will bootstrap context again.", "info");
		},
	});
}
