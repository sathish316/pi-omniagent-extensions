import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const PROVIDER = "rovo-acp";
const API = "rovo-acp";
const ROVO_COMMAND = process.env.ROVO_ACP_COMMAND ?? "rovo";
const ROVO_ARGS = (process.env.ROVO_ACP_ARGS ?? "acp").split(/\s+/).filter(Boolean);
const ROVO_MODE = process.env.ROVO_ACP_MODE; // optional: default | ask | YOLO
const STARTUP_TIMEOUT_MS = Number(process.env.ROVO_ACP_STARTUP_TIMEOUT_MS ?? 30_000);
const REQUEST_TIMEOUT_MS = Number(process.env.ROVO_ACP_REQUEST_TIMEOUT_MS ?? 10 * 60_000);
const AUTO_ALLOW_PERMISSIONS = process.env.ROVO_ACP_AUTO_ALLOW !== "false";
const DEBUG = process.env.ROVO_ACP_DEBUG === "true";

type JsonRpcMessage = {
	jsonrpc?: "2.0";
	id?: string | number | null;
	method?: string;
	params?: any;
	result?: any;
	error?: any;
};

type RovoModelInfo = { modelId: string; name: string };

type TerminalState = {
	process: ChildProcessWithoutNullStreams;
	output: string;
	truncated: boolean;
	exitStatus?: { exitCode?: number; signal?: string };
	waiters: Array<(status: { exitCode?: number; signal?: string }) => void>;
	limit: number;
};

class AcpProcess {
	private proc: ChildProcessWithoutNullStreams;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	private terminals = new Map<string, TerminalState>();
	private closed = false;

	constructor(
		private cwd: string,
		private onNotification?: (message: JsonRpcMessage) => void,
	) {
		this.proc = spawn(ROVO_COMMAND, ROVO_ARGS, {
			cwd,
			env: process.env,
			stdio: "pipe",
		});

		this.proc.stdout.setEncoding("utf8");
		this.proc.stderr.setEncoding("utf8");

		this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		this.proc.stderr.on("data", (chunk: string) => {
			if (DEBUG) process.stderr.write(`[rovo-acp stderr] ${chunk}`);
		});
		this.proc.on("exit", (code, signal) => {
			this.closed = true;
			const error = new Error(`rovo acp exited (${code ?? signal ?? "unknown"})`);
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
		return this.request(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: true,
				},
				clientInfo: { name: "pi rovo-acp extension", version: "0.1.0" },
			},
			STARTUP_TIMEOUT_MS,
		);
	}

	async newSession(cwd = this.cwd): Promise<any> {
		return this.request("session/new", { cwd, mcpServers: [] }, STARTUP_TIMEOUT_MS);
	}

	async setModel(sessionId: string, modelId: string): Promise<void> {
		await this.request("session/set_model", { sessionId, modelId }, STARTUP_TIMEOUT_MS);
	}

	async setMode(sessionId: string, modeId: string): Promise<void> {
		await this.request("session/set_mode", { sessionId, modeId }, STARTUP_TIMEOUT_MS);
	}

	async prompt(sessionId: string, prompt: any[], signal?: AbortSignal): Promise<any> {
		if (signal?.aborted) throw new Error("aborted");
		const abort = () => {
			this.notify("session/cancel", { sessionId }).catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return await this.request("session/prompt", { sessionId, prompt }, REQUEST_TIMEOUT_MS);
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async request(method: string, params?: any, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
		if (this.closed) throw new Error("rovo acp process is closed");
		const id = this.nextId++;
		const payload: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
		const promise = new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`ACP request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		this.write(payload);
		return promise;
	}

	async notify(method: string, params?: any): Promise<void> {
		this.write({ jsonrpc: "2.0", method, params });
	}

	dispose(): void {
		for (const terminal of this.terminals.values()) terminal.process.kill();
		this.terminals.clear();
		if (!this.proc.killed) this.proc.kill();
	}

	private write(message: JsonRpcMessage): void {
		if (DEBUG) process.stderr.write(`[rovo-acp ->] ${JSON.stringify(message)}\n`);
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
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
				if (DEBUG) process.stderr.write(`[rovo-acp <-] ${JSON.stringify(message)}\n`);
				void this.handleMessage(message);
			} catch (error) {
				if (DEBUG) process.stderr.write(`[rovo-acp parse error] ${String(error)} for ${line}\n`);
			}
		}
	}

	private async handleMessage(message: JsonRpcMessage): Promise<void> {
		if (message.id !== undefined && message.method) {
			await this.handleClientRequest(message);
			return;
		}

		if (message.id !== undefined) {
			const id = Number(message.id);
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			if (message.error) {
				const details = message.error.data?.details;
				const baseMessage = message.error.message ?? JSON.stringify(message.error);
				const err = new Error(details ? `${baseMessage}: ${details}` : baseMessage) as Error & {
					code?: number;
				};
				if (typeof message.error.code === "number") err.code = message.error.code;
				pending.reject(err);
			} else pending.resolve(message.result);
			return;
		}

		if (message.method) this.onNotification?.(message);
	}

	private async handleClientRequest(message: JsonRpcMessage): Promise<void> {
		try {
			const result = await this.dispatchClientRequest(message.method!, message.params ?? {});
			this.write({ jsonrpc: "2.0", id: message.id!, result: result ?? {} });
		} catch (error) {
			this.write({
				jsonrpc: "2.0",
				id: message.id!,
				error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	private async dispatchClientRequest(method: string, params: any): Promise<any> {
		switch (method) {
			case "fs/read_text_file":
				return this.readTextFile(params);
			case "fs/write_text_file":
				await fs.mkdir(path.dirname(params.path), { recursive: true });
				await fs.writeFile(params.path, params.content ?? "", "utf8");
				return {};
			case "session/request_permission":
				return this.requestPermission(params);
			case "terminal/create":
				return this.createTerminal(params);
			case "terminal/output":
				return this.terminalOutput(params.terminalId);
			case "terminal/wait_for_exit":
				return this.waitForTerminal(params.terminalId);
			case "terminal/kill":
				this.terminals.get(params.terminalId)?.process.kill();
				return {};
			case "terminal/release":
				this.terminals.delete(params.terminalId);
				return {};
			default:
				throw new Error(`Unsupported ACP client request: ${method}`);
		}
	}

	private async readTextFile(params: any): Promise<{ content: string }> {
		let content = await fs.readFile(params.path, "utf8");
		const line = Number(params.line ?? 0);
		const limit = params.limit == null ? undefined : Number(params.limit);
		if (line > 0 || limit != null) {
			const lines = content.split(/\r?\n/);
			const start = Math.max(0, line > 0 ? line - 1 : 0);
			content = lines.slice(start, limit == null ? undefined : start + limit).join("\n");
		}
		return { content };
	}

	private requestPermission(params: any): any {
		if (!AUTO_ALLOW_PERMISSIONS) return { outcome: { outcome: "cancelled" } };
		const options = Array.isArray(params.options) ? params.options : [];
		const allow = options.find((option: any) => String(option.kind ?? "").startsWith("allow")) ?? options[0];
		if (!allow?.optionId) return { outcome: { outcome: "cancelled" } };
		return { outcome: { outcome: "selected", optionId: allow.optionId } };
	}

	private createTerminal(params: any): { terminalId: string } {
		const terminalId = randomUUID();
		const env = { ...process.env } as Record<string, string>;
		for (const item of params.env ?? []) env[item.name] = item.value;
		const args = Array.isArray(params.args) ? params.args : [];
		const child = spawn(params.command, args, {
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

	private terminalOutput(terminalId: string): any {
		const terminal = this.terminals.get(terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${terminalId}`);
		return { output: terminal.output, truncated: terminal.truncated, exitStatus: terminal.exitStatus ?? null };
	}

	private waitForTerminal(terminalId: string): Promise<any> | any {
		const terminal = this.terminals.get(terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${terminalId}`);
		if (terminal.exitStatus) return terminal.exitStatus;
		return new Promise((resolve) => terminal.waiters.push(resolve));
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

function bridgeNote(configuredModelId: string): string {
	return (
		"# Bridge note\n" +
		`You are Rovo Dev running through ACP, called from Pi (active Rovo model: ${configuredModelId}). ` +
		"Answer the latest user request. If you need to inspect or modify files, use your Rovo tools."
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
	if (delta.length === 0) {
		return { text: "Continue.", newSentCount: messages.length };
	}
	return { text: formatMessages(delta), newSentCount: messages.length };
}

class RovoAcpBridge {
	private acp: AcpProcess | null = null;
	private sessionId: string | null = null;
	private currentModelId: string | null = null;
	private currentModeId: string | null = null;
	private cwd: string | null = null;
	private piSessionKey: string | null = null;
	private sentMessageCount = 0;
	private promptChain: Promise<void> = Promise.resolve();
	private notificationHandler: ((message: JsonRpcMessage) => void) | null = null;

	setNotificationHandler(handler: ((message: JsonRpcMessage) => void) | null): void {
		this.notificationHandler = handler;
	}

	getStatus() {
		return {
			connected: this.acp != null && !this.acp.isClosed(),
			rovoSessionId: this.sessionId,
			currentModelId: this.currentModelId,
			currentModeId: this.currentModeId,
			sentMessageCount: this.sentMessageCount,
			piSessionKey: this.piSessionKey,
			cwd: this.cwd,
		};
	}

	getCurrentModelId(): string | null {
		return this.currentModelId;
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
			this.currentModeId = null;
		}

		if (this.piSessionKey !== piSessionKey || this.cwd !== cwd) {
			await this.dispose();
			this.piSessionKey = piSessionKey;
			this.cwd = cwd;
			this.sentMessageCount = 0;
		}

		if (!this.acp) {
			this.acp = new AcpProcess(cwd, (message) => this.notificationHandler?.(message));
			await this.acp.initialize();
			const session = await this.acp.newSession(cwd);
			this.sessionId = session.sessionId as string;
			this.sentMessageCount = 0;
			await this.applyMode();
		}
	}

	private async applyMode(): Promise<void> {
		if (!this.acp || !this.sessionId || !ROVO_MODE) return;
		if (this.currentModeId === ROVO_MODE) return;
		try {
			await this.acp.setMode(this.sessionId, ROVO_MODE);
			this.currentModeId = ROVO_MODE;
		} catch (error) {
			if (isMethodNotFound(error)) {
				this.currentModeId = ROVO_MODE;
				return;
			}
			throw error;
		}
	}

	private async applyModel(modelId: string): Promise<void> {
		if (!this.acp || !this.sessionId) return;
		if (this.currentModelId === modelId) return;
		// The synthetic fallback model id means rovo did not advertise any
		// selectable models; the agent controls the model itself, so don't try to set it.
		if (isFallbackModelId(modelId)) {
			this.currentModelId = modelId;
			return;
		}
		try {
			await this.acp.setModel(this.sessionId, modelId);
		} catch (error) {
			// Some rovo builds may not implement session/set_model. Treat an
			// unsupported method as a no-op rather than failing model selection.
			if (isMethodNotFound(error)) {
				this.currentModelId = modelId;
				return;
			}
			throw error;
		}
		this.currentModelId = modelId;
	}

	async ensureModel(modelId: string, piSessionKey: string, cwd: string): Promise<void> {
		return this.runExclusive(async () => {
			await this.ensureSession(piSessionKey, cwd);
			await this.applyModel(modelId);
		});
	}

	async resetRovoSession(): Promise<void> {
		return this.runExclusive(async () => {
			if (!this.acp || this.acp.isClosed() || !this.cwd) return;
			const session = await this.acp.newSession(this.cwd);
			this.sessionId = session.sessionId as string;
			this.sentMessageCount = 0;
			this.currentModeId = null;
			await this.applyMode();
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
		this.currentModeId = null;
		this.cwd = null;
		this.piSessionKey = null;
		this.sentMessageCount = 0;
	}
}

const acpBridge = new RovoAcpBridge();
const modelCatalog = new Map<string, RovoModelInfo>();

let boundPiSessionKey: string | undefined;
let boundCwd = process.cwd();

const FALLBACK_MODEL_ID = "default[]";

function isFallbackModelId(modelId: string): boolean {
	return modelId === FALLBACK_MODEL_ID;
}

function isMethodNotFound(error: unknown): boolean {
	const code = (error as { code?: number })?.code;
	if (code === -32601) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /method not found|unsupported|not implemented|unknown method/i.test(message);
}

function contextWindowFor(modelId: string): number {
	const match = modelId.match(/context=(\d+)k/i);
	if (match) return Number(match[1]) * 1000;
	return 200_000;
}

function isReasoningModel(modelId: string): boolean {
	return /thinking=true|reasoning=|opus|gpt-5|gemini/i.test(modelId);
}

async function discoverRovoModels(): Promise<RovoModelInfo[]> {
	const acp = new AcpProcess(process.cwd());
	try {
		await acp.initialize();
		const session = await acp.newSession(process.cwd());
		const models = session?.models?.availableModels;
		if (!Array.isArray(models) || models.length === 0) {
			return [{ modelId: FALLBACK_MODEL_ID, name: "Auto" }];
		}
		return models.map((m: { modelId: string; name: string }) => ({ modelId: m.modelId, name: m.name }));
	} finally {
		acp.dispose();
	}
}

function streamRovoProvider(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	const info = modelCatalog.get(model.id);
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

		const appendText = (delta: string) => {
			if (!delta) return;
			if (thinkingStarted) {
				stream.push({ type: "thinking_end", contentIndex: thinkingIndex!, content: thinking, partial: output });
				thinkingStarted = false;
			}
			if (!textStarted) {
				textIndex = output.content.length;
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
				textStarted = true;
			}
			text += delta;
			const block = output.content[textIndex!] as any;
			block.text = text;
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
			const block = output.content[thinkingIndex!] as any;
			block.thinking = thinking;
			stream.push({ type: "thinking_delta", contentIndex: thinkingIndex!, delta, partial: output });
		};

		const onNotification = (message: JsonRpcMessage) => {
			if (message.method !== "session/update") return;
			const update = message.params?.update;
			if (!update) return;
			if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
				appendText(update.content.text ?? "");
			} else if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") {
				appendThinking(update.content.text ?? "");
			} else if (
				DEBUG &&
				(update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
			) {
				appendText(`\n\n[Rovo ${update.sessionUpdate}: ${update.title ?? update.toolCallId ?? "tool"}]\n`);
			}
		};

		try {
			if (!info) throw new Error(`Unknown rovo-acp model id: ${model.id}`);
			stream.push({ type: "start", partial: output });
			const piSessionKey = boundPiSessionKey ?? `ephemeral:${boundCwd}`;
			acpBridge.setNotificationHandler(onNotification);
			const result = await acpBridge.prompt(context, model.id, piSessionKey, boundCwd, options?.signal);
			output.stopReason = result?.stopReason === "max_tokens" ? "length" : "stop";

			if (thinkingStarted) {
				stream.push({ type: "thinking_end", contentIndex: thinkingIndex!, content: thinking, partial: output });
				thinkingStarted = false;
			}
			if (textStarted) {
				stream.push({ type: "text_end", contentIndex: textIndex!, content: text, partial: output });
			} else {
				appendText("");
				stream.push({ type: "text_end", contentIndex: textIndex!, content: text, partial: output });
			}
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: output });
			stream.end(output);
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			if (thinkingStarted) {
				stream.push({ type: "thinking_end", contentIndex: thinkingIndex!, content: thinking, partial: output });
			}
			if (textStarted) {
				stream.push({ type: "text_end", contentIndex: textIndex!, content: text, partial: output });
			}
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end(output);
		} finally {
			acpBridge.setNotificationHandler(null);
		}
	})();

	return stream;
}

export default async function rovoAcpExtension(pi: ExtensionAPI) {
	let models: RovoModelInfo[];
	try {
		models = await discoverRovoModels();
	} catch (error) {
		models = [{ modelId: FALLBACK_MODEL_ID, name: "Auto" }];
		console.error(
			`[rovo-acp] failed to discover Rovo ACP models: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	for (const m of models) modelCatalog.set(m.modelId, m);

	pi.registerProvider(PROVIDER, {
		name: "Rovo Dev (ACP)",
		baseUrl: "stdio://rovo/acp",
		apiKey: "rovo-acp",
		api: API,
		streamSimple: streamRovoProvider,
		models: models.map((m) => ({
			id: m.modelId,
			name: `Rovo ${m.name}`,
			reasoning: isReasoningModel(m.modelId),
			input: ["text"],
			contextWindow: contextWindowFor(m.modelId),
			maxTokens: 16_384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});

	pi.on("session_start", async (_event, ctx) => {
		boundPiSessionKey = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		boundCwd = ctx.sessionManager.getCwd();
	});

	pi.on("session_shutdown", async () => {
		await acpBridge.dispose();
	});

	pi.on("session_compact", async () => {
		await acpBridge.resetRovoSession();
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider !== PROVIDER) return;
		const piSessionKey = boundPiSessionKey ?? `ephemeral:${boundCwd}`;
		try {
			await acpBridge.ensureModel(event.model.id, piSessionKey, boundCwd);
			ctx.ui.notify(`Rovo ACP model set: ${event.model.id}`, "info");
		} catch (error) {
			ctx.ui.notify(
				`Failed to set Rovo model: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	});

	pi.registerCommand("rovo-acp-status", {
		description: "Show Rovo ACP bridge status",
		handler: async (_args, ctx) => {
			const s = acpBridge.getStatus();
			const lines = [
				`connected: ${s.connected ? "yes" : "no"}`,
				`rovo session: ${s.rovoSessionId ?? "(none)"}`,
				`current model: ${s.currentModelId ?? "(none)"}`,
				`current mode: ${s.currentModeId ?? ROVO_MODE ?? "(agent default)"}`,
				`messages sent: ${s.sentMessageCount}`,
				`pi session key: ${s.piSessionKey ?? "(none)"}`,
				`cwd: ${s.cwd ?? "(none)"}`,
				`available models: ${models.length}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("rovo-acp-reset", {
		description: "Start a new Rovo ACP session (keeps the same Pi session)",
		handler: async (_args, ctx) => {
			await acpBridge.resetRovoSession();
			ctx.ui.notify("Rovo ACP session reset. Next prompt will bootstrap context again.", "info");
		},
	});
}
