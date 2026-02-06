import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";

interface RunResult {
	output: string;
	error?: string;
}

export type ActivityType =
	| "thinking"
	| "reading"
	| "writing"
	| "running"
	| "searching"
	| "working";

export interface ActivityUpdate {
	type: ActivityType;
	detail: string;
	elapsed: number; // seconds
}

export type ActivityCallback = (activity: ActivityUpdate) => void;

// Parse Pi output to detect activity type
function detectActivity(
	line: string,
): { type: ActivityType; detail: string } | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	// Detect common Pi output patterns
	if (/^(Reading|Read)\s+/i.test(trimmed)) {
		const match = trimmed.match(/^(?:Reading|Read)\s+(.+)/i);
		return { type: "reading", detail: match?.[1] || "file" };
	}
	if (/^(Writing|Wrote|Creating|Created)\s+/i.test(trimmed)) {
		const match = trimmed.match(/^(?:Writing|Wrote|Creating|Created)\s+(.+)/i);
		return { type: "writing", detail: match?.[1] || "file" };
	}
	if (/^(Running|Executing|>\s*\$)/i.test(trimmed)) {
		const match = trimmed.match(/^(?:Running|Executing|>\s*\$)\s*(.+)/i);
		return { type: "running", detail: match?.[1]?.slice(0, 50) || "command" };
	}
	if (/^(Searching|Search|Looking|Finding)/i.test(trimmed)) {
		return { type: "searching", detail: "codebase" };
	}
	if (/^(Thinking|Analyzing|Processing)/i.test(trimmed)) {
		return { type: "thinking", detail: "" };
	}

	return null;
}

// Simple lock per chat to prevent concurrent executions
const locks = new Map<number, Promise<void>>();

export async function acquireLock(chatId: number): Promise<() => void> {
	while (locks.has(chatId)) {
		await locks.get(chatId);
	}
	let release: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	locks.set(chatId, promise);
	return () => {
		locks.delete(chatId);
		release?.();
	};
}

function getSessionPath(config: Config, chatId: number): string {
	return join(config.sessionDir, `telegram-${chatId}.jsonl`);
}

export async function runPi(
	config: Config,
	chatId: number,
	prompt: string,
	workspace: string,
): Promise<RunResult> {
	const release = await acquireLock(chatId);

	try {
		// Ensure session directory exists
		await mkdir(config.sessionDir, { recursive: true });

		const sessionPath = getSessionPath(config, chatId);

		const args = [
			"--session",
			sessionPath,
			"--print", // Non-interactive mode
			"--thinking",
			config.thinkingLevel,
			prompt,
		];

		return await new Promise<RunResult>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: workspace,
				env: {
					...process.env,
					// Ensure pi uses the same auth
					PI_AGENT_DIR: join(process.env.HOME || "", ".pi", "agent"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data) => {
				stdout += data.toString();
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (code !== 0 && stderr) {
					resolve({ output: stdout || "Error occurred", error: stderr });
				} else {
					resolve({ output: stdout || "(no output)" });
				}
			});

			proc.on("error", (err) => {
				resolve({ output: "", error: `Failed to start Pi: ${err.message}` });
			});

			// Timeout
			setTimeout(() => {
				proc.kill("SIGTERM");
				resolve({ output: stdout || "", error: "Timeout: Pi took too long" });
			}, config.piTimeoutMs);
		});
	} finally {
		release();
	}
}

export interface RunPiOptions {
	imagePaths?: string[];
}

export async function runPiWithStreaming(
	config: Config,
	chatId: number,
	prompt: string,
	workspace: string,
	onActivity: ActivityCallback,
	options?: RunPiOptions,
): Promise<RunResult> {
	const release = await acquireLock(chatId);
	const startTime = Date.now();
	let lastActivity: ActivityUpdate | null = null;

	try {
		await mkdir(config.sessionDir, { recursive: true });
		const sessionPath = getSessionPath(config, chatId);

		const args = [
			"--session",
			sessionPath,
			"--print",
			"--thinking",
			config.thinkingLevel,
		];

		// Add image paths with @ prefix (pi uses @path for images)
		if (options?.imagePaths) {
			for (const imagePath of options.imagePaths) {
				args.push(`@${imagePath}`);
			}
		}

		// Add the prompt last
		args.push(prompt);

		return await new Promise<RunResult>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: workspace,
				env: {
					...process.env,
					PI_AGENT_DIR: join(process.env.HOME || "", ".pi", "agent"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let lineBuffer = "";

			// Process output line by line for activity detection
			const processLine = (line: string) => {
				const activity = detectActivity(line);
				if (activity) {
					const elapsed = Math.floor((Date.now() - startTime) / 1000);
					lastActivity = { ...activity, elapsed };
					onActivity(lastActivity);
				}
			};

			proc.stdout.on("data", (data) => {
				const chunk = data.toString();
				stdout += chunk;
				lineBuffer += chunk;

				// Process complete lines
				const lines = lineBuffer.split("\n");
				lineBuffer = lines.pop() || "";
				for (const line of lines) {
					processLine(line);
				}
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			// Send periodic "working" updates if no specific activity detected
			const activityInterval = setInterval(() => {
				const elapsed = Math.floor((Date.now() - startTime) / 1000);
				if (!lastActivity || elapsed - lastActivity.elapsed > 5) {
					onActivity({ type: "working", detail: "", elapsed });
				}
			}, 5000);

			proc.on("close", (code) => {
				clearInterval(activityInterval);
				// Process remaining buffer
				if (lineBuffer) {
					processLine(lineBuffer);
				}
				if (code !== 0 && stderr) {
					resolve({ output: stdout || "Error occurred", error: stderr });
				} else {
					resolve({ output: stdout || "(no output)" });
				}
			});

			proc.on("error", (err) => {
				clearInterval(activityInterval);
				resolve({ output: "", error: `Failed to start Pi: ${err.message}` });
			});

			setTimeout(() => {
				clearInterval(activityInterval);
				proc.kill("SIGTERM");
				resolve({ output: stdout || "", error: "Timeout: Pi took too long" });
			}, config.piTimeoutMs);
		});
	} finally {
		release();
	}
}

export async function checkPiAuth(): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("pi", ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		proc.on("close", (code) => {
			resolve(code === 0);
		});

		proc.on("error", () => {
			resolve(false);
		});
	});
}
