/**
 * omp compatibility bridges — self-contained implementations.
 *
 * tau imports these symbols from the pi coding-agent package root, but omp's
 * legacy pi-coding-agent shim does not re-export them, and omp exposes no
 * plugin-reachable channel to its host copies (package subpaths of both
 * `@oh-my-pi/*` and the npm-published `@earendil-works/*` are blocked by
 * exports maps, and canonical bare specifiers get an `?mtime` tag that breaks
 * the host files' own imports). Everything below is therefore implemented
 * locally, on top of the pi-tui shim surface (`@earendil-works/pi-tui` →
 * omp's bundled pi-tui) and node builtins only.
 *
 * BorderedLoader and DynamicBorder are adapted from omp/pi sources (MIT);
 * convertToLlm is adapted from upstream pi's core/messages.ts (MIT).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CancellableLoader,
	type Component,
	Container,
	Spacer,
	type TUI,
	Text,
} from "@earendil-works/pi-tui";

// ─── getAgentDir ─────────────────────────────────────────────────────

/** Approximates omp's agent config directory (~/.omp/agent). */
export function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;
	const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
	if (profile) return join(homedir(), ".omp", "profiles", profile, "agent");
	return join(homedir(), ".omp", "agent");
}

// ─── DEFAULT_COMPACTION_SETTINGS ─────────────────────────────────────

/**
 * pi's compaction default. omp has no equivalent export (compaction is
 * configured through omp settings keys); values mirror upstream pi.
 */
export const DEFAULT_COMPACTION_SETTINGS = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
} as const;

// ─── loadProjectContextFiles ─────────────────────────────────────────

/** Minimal synchronous stand-in for pi's context-file discovery. */
export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir?: string;
}): Array<{ path: string; content: string }> {
	const names = ["AGENTS.md", "CLAUDE.md"];
	const out: Array<{ path: string; content: string }> = [];
	const seen = new Set<string>();
	const add = (p: string): void => {
		if (seen.has(p) || !existsSync(p)) return;
		seen.add(p);
		try {
			out.push({ path: p, content: readFileSync(p, "utf-8") });
		} catch {
			// unreadable context files are skipped
		}
	};
	let dir = resolve(options.cwd);
	for (;;) {
		for (const name of names) add(join(dir, name));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (options.agentDir) {
		for (const name of names) add(join(options.agentDir, name));
	}
	return out;
}

// ─── DynamicBorder ───────────────────────────────────────────────────

/** Full-width horizontal rule that follows the viewport width (pi, MIT). */
export class DynamicBorder implements Component {
	readonly color: (str: string) => string;

	constructor(color: (str: string) => string) {
		this.color = color;
	}

	invalidate(): void {
		// no cached state
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}

// ─── BorderedLoader ──────────────────────────────────────────────────

/** Loader wrapped with dynamic borders (adapted from omp/pi sources, MIT). */
export class BorderedLoader extends Container {
	#loader: CancellableLoader;

	constructor(
		tui: TUI,
		theme: { fg: (name: string, text: string) => string },
		message: string,
	) {
		super();
		const borderColor = (s: string): string => theme.fg("border", s);
		this.addChild(new DynamicBorder(borderColor));
		this.#loader = new CancellableLoader(
			tui,
			s => theme.fg("accent", s),
			s => theme.fg("muted", s),
			message,
		);
		this.addChild(this.#loader);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "esc cancel"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
	}

	get signal(): AbortSignal {
		return this.#loader.signal;
	}

	set onAbort(fn: (() => void) | undefined) {
		this.#loader.onAbort = fn;
	}

	handleInput(data: string): void {
		this.#loader.handleInput(data);
	}

	override dispose(): void {
		this.#loader.dispose();
	}
}

// ─── convertToLlm ────────────────────────────────────────────────────

const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
const BRANCH_SUMMARY_SUFFIX = `</summary>`;
const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;

type LooseMessage = { role?: string; [key: string]: unknown };

function bashExecutionToText(msg: {
	command: string;
	output?: string;
	cancelled?: boolean;
	exitCode?: number | null;
	truncated?: boolean;
	fullOutputPath?: string;
}): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

/**
 * Convert session messages (incl. session-only roles) into plain LLM
 * messages; adapted from upstream pi's core/messages.ts (MIT).
 */
export function convertToLlm(messages: readonly LooseMessage[]): LooseMessage[] {
	const out: LooseMessage[] = [];
	for (const m of messages) {
		switch (m.role) {
			case "bashExecution": {
				if (m.excludeFromContext) break;
				out.push({
					role: "user",
					content: [{ type: "text", text: bashExecutionToText(m as never) }],
					timestamp: m.timestamp,
				});
				break;
			}
			case "custom": {
				const content =
					typeof m.content === "string"
						? [{ type: "text", text: m.content }]
						: (m.content as LooseMessage);
				out.push({ role: "user", content, timestamp: m.timestamp });
				break;
			}
			case "branchSummary":
				out.push({
					role: "user",
					content: [
						{ type: "text", text: BRANCH_SUMMARY_PREFIX + String(m.summary) + BRANCH_SUMMARY_SUFFIX },
					],
					timestamp: m.timestamp,
				});
				break;
			case "compactionSummary":
				out.push({
					role: "user",
					content: [
						{
							type: "text",
							text: COMPACTION_SUMMARY_PREFIX + String(m.summary) + COMPACTION_SUMMARY_SUFFIX,
						},
					],
					timestamp: m.timestamp,
				});
				break;
			case "user":
			case "assistant":
			case "toolResult":
				out.push(m);
				break;
			default:
				break;
		}
	}
	return out;
}

// ─── ANSI theme fallbacks ────────────────────────────────────────────

const RESET = "\x1b[0m";
const wrap =
	(code: string) =>
	(text: string): string =>
		`${code}${text}${RESET}`;
const bold = wrap("\x1b[1m");
const dim = wrap("\x1b[2m");
const italic = wrap("\x1b[3m");
const underline = wrap("\x1b[4m");
const strikethrough = wrap("\x1b[9m");
const cyan = wrap("\x1b[36m");
const yellow = wrap("\x1b[33m");

const BOX_ROUND = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
} as const;

const BOX_SHARP = {
	...BOX_ROUND,
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	teeDown: "┬",
	teeUp: "┴",
	teeLeft: "┤",
	teeRight: "├",
	cross: "┼",
} as const;

const SYMBOLS = {
	cursor: "›",
	inputCursor: "▌",
	boxRound: BOX_ROUND,
	boxSharp: BOX_SHARP,
	table: BOX_SHARP,
	quoteBorder: "▎",
	hrChar: "─",
	spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;

/** ANSI-styled markdown theme (visual fallback; pi derives it from its theme). */
export function getMarkdownTheme() {
	return {
		heading: bold,
		link: cyan,
		linkUrl: dim,
		code: yellow,
		codeBlock: (t: string) => t,
		codeBlockBorder: dim,
		quote: (t: string) => t,
		quoteBorder: dim,
		hr: dim,
		listBullet: yellow,
		bold,
		italic,
		underline,
		strikethrough,
		symbols: SYMBOLS,
	};
}

/** ANSI-styled settings-list theme (visual fallback). */
export function getSettingsListTheme() {
	return {
		label: (text: string, selected: boolean) => (selected ? bold(text) : text),
		value: (text: string, _selected: boolean, changed: boolean) =>
			changed ? yellow(text) : text,
		description: dim,
		warning: yellow,
		warningMark: "⚠",
		cursor: "›",
		hint: dim,
		heading: (text: string, dimmed: boolean) => (dimmed ? dim(text) : bold(text)),
	};
}
