/**
 * Claude Code ACP provider extension for pi.
 *
 * Bridges pi to Claude Code through @agentclientprotocol/claude-agent-acp.
 * Models are registered as normal pi provider models and appear in /model with
 * "[claude-code-acp]" in their display name, similar to cursor-acp and
 * codex-app-server.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
	ClientSideConnection,
	RequestError,
	ndJsonStream,
	type Agent,
	type Client,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	type KillTerminalRequest,
	type KillTerminalResponse,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	type ReleaseTerminalRequest,
	type ReleaseTerminalResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionConfigSelectOption,
	type SessionNotification,
	type WaitForTerminalExitRequest,
	type WaitForTerminalExitResponse,
	type WriteTextFileRequest,
	type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "@agentclientprotocol/claude-agent-acp";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const PROVIDER = "claude-code-acp";
const API = "claude-code-acp";
const PACKAGE_NAME = "@agentclientprotocol/claude-agent-acp";
const STARTUP_TIMEOUT_MS = Number(process.env.CLAUDE_CODE_ACP_STARTUP_TIMEOUT_MS ?? 30_000);
const REQUEST_TIMEOUT_MS = Number(process.env.CLAUDE_CODE_ACP_REQUEST_TIMEOUT_MS ?? 15 * 60_000);
const AUTO_ALLOW_PERMISSIONS = process.env.CLAUDE_CODE_ACP_AUTO_ALLOW !== "false";
const DEBUG = process.env.CLAUDE_CODE_ACP_DEBUG === "true";
const DEFAULT_MODEL_ID = "sonnet";

const require = createRequire(import.meta.url);

type ClaudeModelInfo = {
	id: string;
	displayName: string;
	description?: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
};

type CommandSpec = {
	command: string;
	args: string[];
};

type TerminalState = {
	process: ChildProcessWithoutNullStreams;
	output: string;
	truncated: boolean;
	exitStatus?: { exitCode?: number; signal?: string };
	waiters: Array<(status: { exitCode?: number; signal?: string }) => void>;
	limit: number;
};

function resolveClaudeAcpCommand(): CommandSpec {
	const override = process.env.CLAUDE_CODE_ACP_COMMAND;
	if (override) {
		return { command: override, args: (process.env.CLAUDE_CODE_ACP_ARGS ?? "").split(/\s+/).filter(Boolean) };
	}

	const packageJsonPath = require.resolve(`${PACKAGE_NAME}/package.json`);
	return {
		command: process.execPath,
		args: [resolve(dirname(packageJsonPath), "dist", "index.js")],
	};
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

function bridgeNote(configuredModelId: string): string {
	return (
		"# Bridge note\n" +
		`You are Claude Code running through ACP, called from Pi (active Claude Code model: ${configuredModelId}). ` +
		"Answer the latest user request. Use your Claude Code tools to inspect or modify files in the workspace."
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

function bootstrapPrompt(context: Context, configuredModelId: string): string {
	const parts: string[] = [];
	if (context.systemPrompt) parts.push(`# Pi system prompt\n${context.systemPrompt}`);
	parts.push(bridgeNote(configuredModelId), "# Conversation", formatMessages(context.messages));
	return parts.join("\n\n");
}

function incrementalPrompt(
	context: Context,
	sentMessageCount: number,
	configuredModelId: string,
): { text: string; newSentCount: number } {
	const messages = context.messages;
	if (sentMessageCount === 0 || messages.length < sentMessageCount) {
		return { text: bootstrapPrompt(context, configuredModelId), newSentCount: messages.length };
	}
	const delta = messages.slice(sentMessageCount);
	if (delta.length === 0) return { text: "Continue.", newSentCount: messages.length };
	return { text: formatMessages(delta), newSentCount: messages.length };
}

function contextWindowFor(modelId: string): number {
	if (/opus-4|sonnet-4|haiku-4|opus|sonnet|haiku/i.test(modelId)) return 200_000;
	return 200_000;
}

function maxTokensFor(modelId: string): number {
	if (/haiku/i.test(modelId)) return 8192;
	return 32_768;
}

function isReasoningModel(modelId: string): boolean {
	return !/haiku/i.test(modelId);
}

function modelFallbacks(): ClaudeModelInfo[] {
	return [
		{
			id: "opus",
			displayName: "Opus [claude-code-acp]",
			description: "Claude Code Opus alias",
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 32_768,
		},
		{
			id: "sonnet",
			displayName: "Sonnet [claude-code-acp]",
			description: "Claude Code Sonnet alias",
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 32_768,
		},
		{
			id: "haiku",
			displayName: "Haiku [claude-code-acp]",
			description: "Claude Code Haiku alias",
			reasoning: false,
			contextWindow: 200_000,
			maxTokens: 8192,
		},
	];
}

function flattenSelectOptions(option: SessionConfigOption): SessionConfigSelectOption[] {
	if (option.type !== "select") return [];
	const options = option.options ?? [];
	return options.flatMap((item) => ("value" in item ? [item] : item.options));
}

function modelOptionValues(configOptions?: SessionConfigOption[] | null): ClaudeModelInfo[] {
	const modelOption = configOptions?.find((option) => option.id === "model");
	if (!modelOption || modelOption.type !== "select") return [];

	return flattenSelectOptions(modelOption)
		.map((option) => ({
			id: option.value,
			displayName: `${option.name ?? option.value} [claude-code-acp]`,
			description: option.description ?? undefined,
			reasoning: isReasoningModel(option.value),
			contextWindow: contextWindowFor(option.value),
			maxTokens: maxTokensFor(option.value),
		}))
		.filter((model) => Boolean(model.id));
}

function chooseOptionId(params: RequestPermissionRequest, allowed: boolean): string | undefined {
	const preferredKinds = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
	for (const kind of preferredKinds) {
		const option = params.options.find((candidate) => candidate.kind === kind);
		if (option) return option.optionId;
	}
	return params.options[0]?.optionId;
}

function permissionResponse(optionId: string | undefined): RequestPermissionResponse {
	if (!optionId) return { outcome: { outcome: "cancelled" } };
	return { outcome: { outcome: "selected", optionId } };
}

class ClaudeAcpClient implements Client {
	private terminals = new Map<string, TerminalState>();
	private nextTerminalId = 1;

	constructor(
		private cwd: string,
		private onNotification?: (params: SessionNotification) => void,
	) {}

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.onNotification?.(params);
	}

	async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		if (!AUTO_ALLOW_PERMISSIONS) return permissionResponse(chooseOptionId(params, false));
		return permissionResponse(chooseOptionId(params, true));
	}

	async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
		return { content: await readFile(resolve(this.cwd, params.path), "utf8") };
	}

	async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
		const target = resolve(this.cwd, params.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, params.content ?? "", "utf8");
		return {};
	}

	async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		const terminalId = `claude-code-acp-${this.nextTerminalId++}`;
		const env = { ...process.env } as Record<string, string>;
		for (const item of params.env ?? []) env[item.name] = item.value;
		const child = spawn(params.command, params.args ?? [], {
			cwd: params.cwd || this.cwd,
			env,
			stdio: "pipe",
		});
		const state: TerminalState = {
			process: child,
			output: "",
			truncated: false,
			waiters: [],
			limit: Number(params.outputByteLimit ?? 200_000),
		};
		const append = (chunk: Buffer | string) => {
			state.output += chunk.toString();
			if (state.output.length > state.limit) {
				state.output = state.output.slice(-state.limit);
				state.truncated = true;
			}
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("exit", (code, signal) => {
			state.exitStatus = { exitCode: code ?? undefined, signal: signal ?? undefined };
			for (const waiter of state.waiters) waiter(state.exitStatus);
			state.waiters = [];
		});
		this.terminals.set(terminalId, state);
		return { terminalId };
	}

	async terminalOutput(params: { terminalId: string }) {
		const terminal = this.terminals.get(params.terminalId);
		if (!terminal) throw RequestError.resourceNotFound(params.terminalId);
		return { output: terminal.output, truncated: terminal.truncated, exitStatus: terminal.exitStatus ?? null };
	}

	async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
		const terminal = this.terminals.get(params.terminalId);
		if (!terminal) throw RequestError.resourceNotFound(params.terminalId);
		if (terminal.exitStatus) return terminal.exitStatus;
		return new Promise((resolveWait) => terminal.waiters.push(resolveWait));
	}

	async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse | void> {
		this.terminals.get(params.terminalId)?.process.kill();
	}

	async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse | void> {
		const terminal = this.terminals.get(params.terminalId);
		if (!terminal) return;
		if (!terminal.process.killed) terminal.process.kill();
		this.terminals.delete(params.terminalId);
	}

	dispose(): void {
		for (const terminal of this.terminals.values()) {
			if (!terminal.process.killed) terminal.process.kill();
		}
		this.terminals.clear();
	}
}

class ClaudeAcpProcess {
	private child: ChildProcessWithoutNullStreams;
	private connection: ClientSideConnection;
	private client: ClaudeAcpClient;
	private agent?: Agent;
	private closed = false;
	private stderr = "";

	constructor(
		private cwd: string,
		onNotification?: (params: SessionNotification) => void,
	) {
		const { command, args } = resolveClaudeAcpCommand();
		this.child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: "pipe",
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderr += chunk;
			if (DEBUG) process.stderr.write(`[claude-code-acp stderr] ${chunk}`);
		});
		this.child.on("exit", () => {
			this.closed = true;
		});

		this.client = new ClaudeAcpClient(cwd, onNotification);
		const output = nodeToWebWritable(this.child.stdin) as unknown as WritableStream<Uint8Array>;
		const input = nodeToWebReadable(this.child.stdout) as unknown as ReadableStream<Uint8Array>;
		this.connection = new ClientSideConnection((agent) => {
			this.agent = agent;
			return this.client;
		}, ndJsonStream(output, input));
	}

	isClosed(): boolean {
		return this.closed || this.child.killed;
	}

	getStderr(): string {
		return this.stderr.trim();
	}

	async initialize(): Promise<void> {
		await this.withTimeout(
			this.connection.initialize({
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: true,
				},
				clientInfo: { name: "pi claude-code-acp extension", version: "0.2.0" },
			}),
			STARTUP_TIMEOUT_MS,
			"initialize",
		);
	}

	async newSession(cwd = this.cwd): Promise<any> {
		return this.withTimeout(this.agent!.newSession({ cwd, mcpServers: [] }), STARTUP_TIMEOUT_MS, "session/new");
	}

	async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
		await this.withTimeout(
			(this.agent!.setSessionConfigOption?.({ sessionId, configId, value }) ?? Promise.resolve()).then(
				() => undefined,
			),
			STARTUP_TIMEOUT_MS,
			`session/set_config_option:${configId}`,
		);
	}

	async prompt(sessionId: string, prompt: any[], signal?: AbortSignal): Promise<any> {
		if (signal?.aborted) throw new Error("aborted");
		const abort = () => {
			void this.connection.cancel({ sessionId }).catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return await this.withTimeout(
				this.agent!.prompt({ sessionId, prompt }),
				REQUEST_TIMEOUT_MS,
				"session/prompt",
			);
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async closeSession(sessionId: string): Promise<void> {
		await this.agent?.closeSession?.({ sessionId }).catch(() => undefined);
	}

	dispose(): void {
		this.client.dispose();
		if (!this.child.killed) this.child.kill();
	}

	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<T>((_, reject) => {
					timer = setTimeout(() => {
						const detail = this.getStderr();
						reject(new Error(`Claude ACP request timed out: ${label}${detail ? `\n${detail}` : ""}`));
					}, timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

class ClaudeAcpBridge {
	private acp: ClaudeAcpProcess | null = null;
	private sessionId: string | null = null;
	private currentModelId: string | null = null;
	private cwd: string | null = null;
	private piSessionKey: string | null = null;
	private sentMessageCount = 0;
	private promptChain: Promise<void> = Promise.resolve();
	private notificationHandler: ((params: SessionNotification) => void) | null = null;

	setNotificationHandler(handler: ((params: SessionNotification) => void) | null): void {
		this.notificationHandler = handler;
	}

	getStatus() {
		return {
			connected: this.acp != null && !this.acp.isClosed(),
			claudeSessionId: this.sessionId,
			currentModelId: this.currentModelId,
			sentMessageCount: this.sentMessageCount,
			piSessionKey: this.piSessionKey,
			cwd: this.cwd,
		};
	}

	private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.promptChain.then(fn, fn);
		this.promptChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async ensureSession(piSessionKey: string, cwd: string): Promise<void> {
		if (this.acp?.isClosed()) {
			this.acp = null;
			this.sessionId = null;
			this.currentModelId = null;
		}

		if (this.piSessionKey !== piSessionKey || this.cwd !== cwd) {
			await this.dispose();
			this.piSessionKey = piSessionKey;
			this.cwd = cwd;
			this.sentMessageCount = 0;
		}

		if (!this.acp) {
			this.acp = new ClaudeAcpProcess(cwd, (message) => this.notificationHandler?.(message));
			await this.acp.initialize();
			const session = await this.acp.newSession(cwd);
			this.sessionId = session.sessionId as string;
			this.sentMessageCount = 0;
		}
	}

	private async applyModel(modelId: string): Promise<void> {
		if (!this.acp || !this.sessionId || this.currentModelId === modelId) return;
		await this.acp.setConfigOption(this.sessionId, "model", modelId);
		this.currentModelId = modelId;
	}

	async ensureModel(modelId: string, piSessionKey: string, cwd: string): Promise<void> {
		return this.runExclusive(async () => {
			await this.ensureSession(piSessionKey, cwd);
			await this.applyModel(modelId);
		});
	}

	async resetClaudeSession(): Promise<void> {
		return this.runExclusive(async () => {
			if (!this.acp || this.acp.isClosed() || !this.cwd) return;
			if (this.sessionId) await this.acp.closeSession(this.sessionId);
			const session = await this.acp.newSession(this.cwd);
			this.sessionId = session.sessionId as string;
			this.sentMessageCount = 0;
			const previousModel = this.currentModelId;
			this.currentModelId = null;
			if (previousModel) await this.applyModel(previousModel);
		});
	}

	async prompt(
		context: Context,
		modelId: string,
		piSessionKey: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<any> {
		return this.runExclusive(async () => {
			await this.ensureSession(piSessionKey, cwd);
			await this.applyModel(modelId);
			const { text, newSentCount } = incrementalPrompt(context, this.sentMessageCount, modelId);
			this.sentMessageCount = newSentCount;
			return this.acp!.prompt(this.sessionId!, [{ type: "text", text }], signal);
		});
	}

	async dispose(): Promise<void> {
		this.acp?.dispose();
		this.acp = null;
		this.sessionId = null;
		this.currentModelId = null;
		this.cwd = null;
		this.piSessionKey = null;
		this.sentMessageCount = 0;
	}
}

const bridge = new ClaudeAcpBridge();
const modelCatalog = new Map<string, ClaudeModelInfo>();

let boundPiSessionKey: string | undefined;
let boundCwd = process.cwd();

async function discoverClaudeModels(): Promise<ClaudeModelInfo[]> {
	const acp = new ClaudeAcpProcess(process.cwd());
	try {
		await acp.initialize();
		const session = await acp.newSession(process.cwd());
		const discovered = modelOptionValues(session.configOptions);
		if (discovered.length > 0) return discovered;
		return modelFallbacks();
	} finally {
		acp.dispose();
	}
}

function streamClaudeProvider(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
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
			if (!thinkingStarted) return;
			stream.push({ type: "thinking_end", contentIndex: thinkingIndex!, content: thinking, partial: output });
			thinkingStarted = false;
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

		const onNotification = (params: SessionNotification) => {
			const update = params.update;
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
				appendText(update.content.text ?? "");
			} else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
				appendThinking(update.content.text ?? "");
			} else if (
				DEBUG &&
				(update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
			) {
				appendText(`\n\n[Claude Code ${update.sessionUpdate}: ${update.title ?? update.toolCallId ?? "tool"}]\n`);
			}
		};

		try {
			if (!modelCatalog.has(model.id)) throw new Error(`Unknown Claude Code ACP model id: ${model.id}`);
			stream.push({ type: "start", partial: output });
			const piSessionKey = boundPiSessionKey ?? `ephemeral:${boundCwd}`;
			bridge.setNotificationHandler(onNotification);
			const result = await bridge.prompt(context, model.id, piSessionKey, boundCwd, options?.signal);
			output.stopReason = result?.stopReason === "max_tokens" ? "length" : "stop";

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
		} finally {
			bridge.setNotificationHandler(null);
		}
	})();

	return stream;
}

export default async function claudeCodeAcpExtension(pi: ExtensionAPI) {
	let models: ClaudeModelInfo[];
	try {
		models = await discoverClaudeModels();
	} catch (error) {
		models = modelFallbacks();
		console.error(
			`[claude-code-acp] failed to discover Claude Code ACP models: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	for (const model of models) modelCatalog.set(model.id, model);

	pi.registerProvider(PROVIDER, {
		baseUrl: "stdio://claude-agent-acp",
		apiKey: "claude-code-acp",
		api: API,
		streamSimple: streamClaudeProvider,
		models: models.map((model) => ({
			id: model.id,
			name: model.displayName,
			reasoning: model.reasoning,
			input: ["text", "image"],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});

	pi.on("session_start", async (_event, ctx) => {
		boundPiSessionKey = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		boundCwd = ctx.sessionManager.getCwd();
	});

	pi.on("session_shutdown", async () => {
		await bridge.dispose();
	});

	pi.on("session_compact", async () => {
		await bridge.resetClaudeSession();
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider !== PROVIDER) return;
		const piSessionKey = boundPiSessionKey ?? `ephemeral:${boundCwd}`;
		try {
			await bridge.ensureModel(event.model.id, piSessionKey, boundCwd);
			ctx.ui.notify(`Claude Code ACP model set: ${event.model.name}`, "info");
		} catch (error) {
			ctx.ui.notify(
				`Failed to set Claude Code model: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	});

	pi.registerCommand("claude-code-acp-status", {
		description: "Show Claude Code ACP bridge status",
		handler: async (_args, ctx) => {
			const s = bridge.getStatus();
			const command = resolveClaudeAcpCommand();
			const lines = [
				`connected: ${s.connected ? "yes" : "no"}`,
				`claude session: ${s.claudeSessionId ?? "(none)"}`,
				`current model: ${s.currentModelId ?? "(none)"}`,
				`messages sent: ${s.sentMessageCount}`,
				`pi session key: ${s.piSessionKey ?? "(none)"}`,
				`cwd: ${s.cwd ?? "(none)"}`,
				`available models: ${models.length}`,
				`command: ${command.command} ${command.args.join(" ")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("claude-code-acp-reset", {
		description: "Start a new Claude Code ACP session (keeps the same Pi session)",
		handler: async (_args, ctx) => {
			await bridge.resetClaudeSession();
			ctx.ui.notify("Claude Code ACP session reset. Next prompt will bootstrap context again.", "info");
		},
	});
}
