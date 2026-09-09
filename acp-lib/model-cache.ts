/**
 * Disk cache for ACP model discovery.
 *
 * Discovering ACP models means spawning the underlying agent CLI
 * (cursor-agent, claude-agent-acp, ...), which is the bulk of pi's startup
 * time on new sessions and /reload. Model lists rarely change, so each
 * provider caches its discovery result here and registers from cache at
 * startup; a stale cache is refreshed in the background after session_start
 * (see the ACP extensions) and can be forced with /acp refresh.
 *
 * Cache location: <extensions dir>/acp-cache/<provider>.json
 * TTL: ACP_MODEL_CACHE_TTL_MS env (default 24h).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type ModelCacheEntry<T> = {
	savedAt: number;
	models: T[];
};

function cacheDir(): string {
	const override = process.env.PI_ACP_CACHE_DIR?.trim();
	if (override) return path.resolve(override);
	try {
		// acp-lib/model-cache.ts -> acp-lib -> extensions
		return path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "acp-cache");
	} catch {
		return path.join(os.homedir(), ".pi", "agent", "extensions", "acp-cache");
	}
}

export function modelCacheTtlMs(): number {
	const raw = Number(process.env.ACP_MODEL_CACHE_TTL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * Read a provider's cached models, or null when missing/unreadable/empty.
 * Shape validation of individual entries is the caller's revive function's
 * job; here we only trust the envelope.
 */
export function readModelCache<T>(provider: string): ModelCacheEntry<T> | null {
	try {
		const raw = fs.readFileSync(path.join(cacheDir(), `${provider}.json`), "utf8");
		const parsed = JSON.parse(raw) as ModelCacheEntry<T>;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof parsed.savedAt !== "number" ||
			!Array.isArray(parsed.models) ||
			parsed.models.length === 0
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/** Atomic write (tmp + rename) so a killed pi never leaves a torn cache. */
export function writeModelCache<T>(provider: string, models: T[]): void {
	if (!Array.isArray(models) || models.length === 0) return;
	const dir = cacheDir();
	const target = path.join(dir, `${provider}.json`);
	const tmp = `${target}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tmp, `${JSON.stringify({ savedAt: Date.now(), models }, null, 2)}\n`, "utf8");
		fs.renameSync(tmp, target);
	} catch (error) {
		// A read-only or unwritable cache dir only costs us freshness.
		console.error(
			`[acp model-cache] failed to write ${target}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Age of a cache entry in ms. */
export function modelCacheAgeMs(entry: ModelCacheEntry<unknown>): number {
	return Math.max(0, Date.now() - entry.savedAt);
}

/** True when the entry is older than the configured TTL. */
export function isModelCacheStale(entry: ModelCacheEntry<unknown>): boolean {
	return modelCacheAgeMs(entry) > modelCacheTtlMs();
}
