/**
 * WorkBuddy desktop "at-rest" credential decryption.
 *
 * From desktop 5.6.0 the WorkBuddy app no longer stores `auth.accessToken` /
 * `auth.refreshToken` as plain strings. It writes a field wrapper:
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64 of a JSON envelope>" }
 *
 * where the envelope is `{suite, keyId, nonce, authTag, ciphertext}` for
 * AES-256-GCM with a 12-byte nonce and a 16-byte tag. The additional
 * authenticated data is a length-prefixed transcript over the scheme, suite,
 * keyId and framing, so the ciphertext only opens for the exact field shape it
 * was sealed for.
 *
 * The field key is not a user secret: it is a build-time constant compiled into
 * the app's own Electron native module
 * (`electron_browser_workbuddy_storage`). The app returns it through
 * `loggerGet()` and the key is the SHA-256 of the returned base64 STRING (not
 * its decoded bytes); `keyId` is the first 16 hex characters of that key's own
 * SHA-256.
 *
 * This module re-derives the same key by asking the installed app for the same
 * payload and caches it in memory for the process lifetime. Nothing is written
 * to disk and the payload is never logged.
 *
 * Provenance: the envelope framing, AAD transcript, executable discovery and
 * the `ELECTRON_RUN_AS_NODE` key fetch are a port of
 * `dingminhua/dsh-connect-workbuddy` (MIT, Copyright (c) 2026 LaoDing),
 * verified against a real Windows install (desktop 5.7.3).
 *
 * @module dsh-coding-subscription-oauth/workbuddy-at-rest
 */

import { execFile, execFileSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

/** A `{$wbEncrypted:1,envelope}` field wrapper, the only shape this module opens. */
export interface WorkBuddyEncryptedField {
	$wbEncrypted: 1;
	envelope: string;
}

/** Envelope framing names, mapped to the single-byte AAD framing code. */
const FRAMING_CODE: Readonly<Record<string, number>> = {
	file: 1,
	field: 2,
	record: 3,
	stream: 4,
};

/** Standard (symmetric) format identifiers, transcripted into the AAD. */
const STANDARD_FORMAT_ID: Readonly<Record<string, string>> = {
	file: "WBEF1",
	field: "WBEV1",
	record: "WBER1",
	stream: "WBES1",
};

/** Domain separator the AAD transcript starts with. */
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");

/** Scheme name of the symmetric envelope this module opens. */
const SYMMETRIC_SCHEME = "sym-v1";

/** Env override pointing at the WorkBuddy desktop executable. */
export const WORKBUDDY_APP_EXECUTABLE_ENV = "WORKBUDDY_APP_EXECUTABLE";

/** How long the app is given to answer with its key payload. */
const KEY_FETCH_TIMEOUT_MS = 10_000;

/** File name of the WorkBuddy desktop executable on Windows. */
const APP_EXECUTABLE_NAME = "WorkBuddy.exe";

/** macOS bundles the desktop app may be installed as, in probe order. */
const MACOS_APP_BUNDLE_NAMES: readonly string[] = ["WorkBuddy.app", "WorkBuddy AI.app"];

/**
 * Bundle identifier prefixes the desktop app is signed with — `com.tencent.
 * workbuddy` (domestic) and `com.workbuddy` (international).
 *
 * The identifier is what makes a directory scan safe to exec: every Electron
 * app ships a binary called `Electron`, so a name-only match could launch a
 * different product.
 */
const APP_BUNDLE_IDENTIFIER_PREFIXES: readonly string[] = ["com.tencent.workbuddy", "com.workbuddy"];

/** Options for the registry probe; `windowsHide` avoids a console flash in the GUI host. */
const REGISTRY_PROBE_OPTIONS = { encoding: "utf8", windowsHide: true, timeout: 10_000 } as const;

function encodeUint32(value: number): Buffer {
	const bytes = Buffer.allocUnsafe(4);
	bytes.writeUInt32BE(value);
	return bytes;
}

/** Length-prefixed UTF-8 string: uint32 big-endian length followed by the bytes. */
function encodeLengthPrefixed(value: string): Buffer {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([encodeUint32(bytes.length), bytes]);
}

/**
 * The additional authenticated data for one `sym-v1` FIELD-framed envelope.
 *
 * Only the field framing is implemented: it is the shape the desktop app uses
 * for credential fields, and an unexpected framing is a parse error rather than
 * a silently wrong transcript.
 */
function fieldAad(keyId: string, suite: number, scheme: string = SYMMETRIC_SCHEME): Buffer {
	if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error("workbuddy: envelope keyId is malformed");
	return Buffer.concat([
		AAD_DOMAIN,
		Buffer.from([1]),
		encodeLengthPrefixed(STANDARD_FORMAT_ID["field"] as string),
		encodeLengthPrefixed(scheme),
		encodeUint32(suite),
		encodeLengthPrefixed(keyId),
		Buffer.from([FRAMING_CODE["field"] as number]),
		// encodeOptionalUint64(undefined): field framing carries no sequence.
		Buffer.from([0]),
		// final === undefined
		Buffer.from([0]),
	]);
}

/** Whether a value is the app's encrypted-field wrapper. */
export function isEncryptedFieldWrapper(value: unknown): value is WorkBuddyEncryptedField {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapper = value as Record<string, unknown>;
	const keys = Object.keys(wrapper).sort();
	return (
		keys.length === 2 &&
		keys[0] === "$wbEncrypted" &&
		keys[1] === "envelope" &&
		wrapper["$wbEncrypted"] === 1 &&
		typeof wrapper["envelope"] === "string"
	);
}

/**
 * The at-rest key id for a derived 32-byte key: the first 16 hex characters of
 * its SHA-256. Checked against the envelope's own `keyId`, so a mismatched key
 * fails loudly instead of returning garbage.
 */
export function deriveAtRestKeyId(key: Buffer): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Derive the 32-byte field key from the app's key payload JSON.
 *
 * The app hashes the payload's base64 STRING — not its decoded bytes — so the
 * same spelling is required here; hashing the decoded secret would produce a
 * different key and every field would fail to open.
 */
export function deriveAtRestKey(payloadJson: string): Buffer {
	let payload: unknown;
	try {
		payload = JSON.parse(payloadJson);
	} catch {
		throw new Error("workbuddy: at-rest key payload is not valid JSON");
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("workbuddy: at-rest key payload is not an object");
	}
	const secret = (payload as Record<string, unknown>)["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") {
		throw new Error("workbuddy: at-rest key payload carries no atRestSecretKey");
	}
	return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Open one encrypted field with a derived key and return its plaintext.
 *
 * Throws when the envelope is malformed, belongs to another key, or fails
 * authentication — a GCM tag mismatch is the signal that the transcript or the
 * key is wrong, and it must never degrade into a truncated token.
 */
export function openEncryptedField(field: WorkBuddyEncryptedField, key: Buffer): string {
	let envelope: unknown;
	try {
		envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
	} catch {
		throw new Error("workbuddy: encrypted field envelope is not valid JSON");
	}
	if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
		throw new Error("workbuddy: encrypted field envelope is not an object");
	}
	const record = envelope as Record<string, unknown>;
	const suite = record["suite"];
	const keyId = record["keyId"];
	const nonce = record["nonce"];
	const authTag = record["authTag"];
	const ciphertext = record["ciphertext"];
	if (typeof suite !== "number" || typeof keyId !== "string") {
		throw new Error("workbuddy: encrypted field envelope is missing suite or keyId");
	}
	if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") {
		throw new Error("workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext");
	}
	const expectedKeyId = deriveAtRestKeyId(key);
	if (keyId !== expectedKeyId) {
		throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`);
	}
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
	decipher.setAAD(fieldAad(keyId, suite));
	decipher.setAuthTag(Buffer.from(authTag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/**
 * The executable inside a macOS app bundle, read from the bundle's own
 * `Info.plist`.
 *
 * The binary is not reliably named after the app: the WorkBuddy bundles ship
 * with `CFBundleExecutable` set to `Electron`, so a path assembled as
 * `<bundle>/Contents/MacOS/WorkBuddy` does not exist and the app looks absent
 * even when it is installed. Asking the bundle is the correct and rename-proof
 * answer.
 */
export function macosBundleExecutable(bundle: string): string | undefined {
	let plist: string;
	try {
		plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
	} catch {
		return undefined;
	}
	const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist);
	const name = match?.[1]?.trim();
	if (name === undefined || name === "") return undefined;
	return join(bundle, "Contents", "MacOS", name);
}

/** Whether a bundle identifies itself as the WorkBuddy desktop app. */
export function isWorkbuddyBundle(bundle: string): boolean {
	let plist: string;
	try {
		plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
	} catch {
		return false;
	}
	const match = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist);
	const identifier = match?.[1]?.trim().toLowerCase();
	if (identifier === undefined || identifier === "") return false;
	return APP_BUNDLE_IDENTIFIER_PREFIXES.some((prefix) => identifier === prefix || identifier.startsWith(`${prefix}.`));
}

/**
 * Bundles of the desktop app found one level BELOW a macOS applications
 * directory, each confirmed by {@link isWorkbuddyBundle} before use.
 *
 * A missing or unreadable parent is the normal case, not an error.
 */
export function macosNestedAppBundles(parent: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return [];
	}
	const bundles: string[] = [];
	for (const entry of entries) {
		const nested = join(parent, entry);
		for (const name of MACOS_APP_BUNDLE_NAMES) {
			const bundle = join(nested, name);
			try {
				if (!statSync(bundle).isDirectory()) continue;
			} catch {
				continue;
			}
			if (isWorkbuddyBundle(bundle)) bundles.push(bundle);
		}
	}
	return bundles;
}

/**
 * Candidate paths of the WorkBuddy desktop executable, in probe order.
 *
 * `win32.join` rather than the host's `join` on the Windows branch: those paths
 * are Windows paths by construction, and `path.join` follows the RUNNING
 * platform, so a POSIX host would insert `/` separators that never exist.
 */
export function workbuddyAppExecutableCandidates(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
	readBundleExecutable: (bundle: string) => string | undefined = macosBundleExecutable,
): string[] {
	const candidates: (string | undefined)[] = [env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()];
	if (platform === "win32") {
		const local = env["LOCALAPPDATA"]?.trim();
		const programFiles = env["ProgramFiles"]?.trim();
		const programFilesX86 = env["ProgramFiles(x86)"]?.trim();
		candidates.push(
			local === undefined || local === "" ? undefined : win32.join(local, "Programs", "WorkBuddy", APP_EXECUTABLE_NAME),
			local === undefined || local === "" ? undefined : win32.join(local, "WorkBuddy", APP_EXECUTABLE_NAME),
			programFiles === undefined || programFiles === ""
				? undefined
				: win32.join(programFiles, "WorkBuddy", APP_EXECUTABLE_NAME),
			programFilesX86 === undefined || programFilesX86 === ""
				? undefined
				: win32.join(programFilesX86, "WorkBuddy", APP_EXECUTABLE_NAME),
		);
	} else if (platform === "darwin") {
		for (const name of MACOS_APP_BUNDLE_NAMES) {
			candidates.push(
				readBundleExecutable(join("/Applications", name)),
				readBundleExecutable(join(home, "Applications", name)),
			);
		}
	}
	return candidates.filter((candidate): candidate is string => candidate !== undefined && candidate !== "");
}

/**
 * The path inside a `DisplayIcon`/`InstallLocation` value, unquoted.
 *
 * Registry data may be quoted (`"D:\app\WorkBuddy.exe",0`) or bare. Only a
 * leading quote is treated as quoting: a bare `C:\dir\a"b.exe` is a real (if
 * unusual) filename and must not be truncated at the quote.
 */
export function stripRegistryQuotes(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	if (!trimmed.startsWith('"')) return trimmed;
	const closing = trimmed.indexOf('"', 1);
	if (closing === -1) return undefined;
	return trimmed.slice(1, closing).trim();
}

/**
 * A registry executable value reduced to a usable path, or undefined when it
 * cannot be one.
 *
 * `DisplayIcon` is stored as `"D:\app\WorkBuddy.exe",0`; the quotes and the icon
 * index are stripped, and a value naming something other than the desktop
 * executable (an `.ico`, an uninstaller) is rejected rather than launched.
 * `win32.basename` is used because the separator belongs to the registry value,
 * which is always Windows.
 */
export function normalizeRegistryExecutable(value: string): string | undefined {
	const unquoted = stripRegistryQuotes(value);
	if (unquoted === undefined || unquoted === "") return undefined;
	const withoutIndex = unquoted.replace(/,\s*-?\d+\s*$/u, "");
	if (withoutIndex === "") return undefined;
	if (win32.basename(withoutIndex).toLowerCase() !== APP_EXECUTABLE_NAME.toLowerCase()) return undefined;
	return withoutIndex;
}

/** Parse `reg query` output for the value that names the installed executable. */
export function registryExecutableFromQuery(output: string): string | undefined {
	for (const rawLine of output.split(/\r?\n/u)) {
		const match = /^\s*DisplayIcon\s+REG_SZ\s+(.*?)\s*$/u.exec(rawLine);
		if (match === null) continue;
		const executable = normalizeRegistryExecutable(match[1] as string);
		if (executable !== undefined) return executable;
	}
	return undefined;
}

/**
 * The `WorkBuddy.exe` under an `InstallLocation`-style registry directory.
 *
 * `win32.join` for the reason given on {@link workbuddyAppExecutableCandidates}:
 * the separator is fixed by the DATA, not by the host.
 */
export function registryInstallLocationFromQuery(output: string): string | undefined {
	for (const rawLine of output.split(/\r?\n/u)) {
		const match = /^\s*InstallLocation\s+REG_SZ\s+(.*?)\s*$/u.exec(rawLine);
		if (match === null) continue;
		const directory = stripRegistryQuotes(match[1] as string);
		if (directory === undefined || directory === "") continue;
		return win32.join(directory, APP_EXECUTABLE_NAME);
	}
	return undefined;
}

/**
 * The registered WorkBuddy executable, from all three uninstall views.
 *
 * The hive a registration lands in depends on how the app was installed:
 * per-user registers under `HKCU` (the layout WorkBuddy uses), a machine-wide
 * install under `HKLM`, and a 32-bit machine-wide one under
 * `HKLM\...\WOW6432Node`. A hive that does not exist is the normal case on a
 * machine without the app, not an error.
 *
 * `DisplayIcon` is tried first because it names the binary directly;
 * `InstallLocation` is the fallback for a registration that omits the icon.
 */
export async function windowsRegistryAppExecutable(
	query: (args: readonly string[]) => Promise<string | undefined> = queryRegistry,
): Promise<string | undefined> {
	const roots = [
		"HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
		"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
		"HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	];
	for (const root of roots) {
		const listing = await query(["query", root, "/s", "/f", "WorkBuddy", "/t", "REG_SZ"]);
		if (listing === undefined) continue;
		const executable = registryExecutableFromQuery(listing);
		if (executable !== undefined) return executable;
		const fromDirectory = registryInstallLocationFromQuery(listing);
		if (fromDirectory !== undefined) return fromDirectory;
	}
	return undefined;
}

/**
 * Run `reg query` and return its stdout, or undefined when it cannot be run.
 *
 * `windowsHide` is required, not cosmetic: the DSH Desktop host is an Electron
 * GUI process with no console, so spawning a console program without it flashes
 * a visible black window on every probe.
 */
async function queryRegistry(args: readonly string[]): Promise<string | undefined> {
	try {
		return execFileSync("reg", [...args], REGISTRY_PROBE_OPTIONS);
	} catch {
		// `reg` exits non-zero when the key or value is absent — the expected case
		// on a machine without a registered WorkBuddy.
		return undefined;
	}
}

export interface FindWorkBuddyExecutableOptions {
	platform?: NodeJS.Platform;
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Injectable for tests; defaults to the real registry probe on Windows. */
	registry?: (args: readonly string[]) => Promise<string | undefined>;
	exists?: (path: string) => boolean;
}

/**
 * The WorkBuddy desktop executable, or undefined when it cannot be found.
 *
 * The registry is consulted first on Windows because the installer recorded the
 * real path; the fixed candidates cover a per-user layout the registration
 * omits, and macOS additionally scans one level below each applications
 * directory for a filed-away bundle.
 */
export async function findWorkbuddyAppExecutable(
	options: FindWorkBuddyExecutableOptions = {},
): Promise<string | undefined> {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const exists = options.exists ?? existsSync;
	const seen = new Set<string>();
	const accept = (candidate: string | undefined): string | undefined => {
		if (candidate === undefined || candidate === "" || seen.has(candidate)) return undefined;
		seen.add(candidate);
		return exists(candidate) ? candidate : undefined;
	};

	if (platform === "win32") {
		const registry = options.registry ?? queryRegistry;
		if (options.registry !== undefined || platform === process.platform) {
			const registered = accept(await windowsRegistryAppExecutable(registry).catch(() => undefined));
			if (registered !== undefined) return registered;
		}
	}
	for (const candidate of workbuddyAppExecutableCandidates(platform, home, env)) {
		const accepted = accept(candidate);
		if (accepted !== undefined) return accepted;
	}
	// macOS fallback: an app filed into a subfolder, which the exact-path
	// candidates above cannot see.
	if (platform === "darwin") {
		for (const parent of ["/Applications", join(home, "Applications")]) {
			for (const bundle of macosNestedAppBundles(parent)) {
				const accepted = accept(macosBundleExecutable(bundle));
				if (accepted !== undefined) return accepted;
			}
		}
	}
	return undefined;
}

/**
 * Ask the installed desktop app for its key payload by running its own binary
 * as plain Node (`ELECTRON_RUN_AS_NODE`) and calling the native binding.
 *
 * The binding is the app's own public surface for this value, so the plugin
 * never carries a copy of a build-specific constant: it asks the very build that
 * wrote the file. The child is given no stdin and a hard timeout, and only its
 * stdout is read.
 */
export function fetchAtRestKeyPayload(executable: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const source =
			"try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}" +
			"catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";
		execFile(
			executable,
			["-e", source],
			{
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
				timeout: KEY_FETCH_TIMEOUT_MS,
				windowsHide: true,
				maxBuffer: 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (error !== null) {
					reject(
						new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`),
					);
					return;
				}
				const payload = stdout.trim();
				if (payload === "") {
					reject(new Error("workbuddy: the desktop app returned an empty at-rest key payload"));
					return;
				}
				resolve(payload);
			},
		);
	});
}

/** Process-lifetime cache of the derived key; never persisted. */
let cachedKey: Buffer | undefined;
let inflightKey: Promise<Buffer | undefined> | undefined;

/**
 * The desktop app's at-rest field key, or undefined when it cannot be obtained
 * (app not installed, an older build without the native module, or a future
 * build that rotates the payload). Cached after the first success so the app is
 * spawned at most once per process; a failure is retried on the next call,
 * because the user may install or start the app between reads.
 *
 * A failure returns undefined rather than throwing: the caller distinguishes
 * "this document is encrypted and unreadable" from "this document is not a
 * credential", and only the former deserves the install-the-app advice.
 */
export function readAtRestKey(): Promise<Buffer | undefined> {
	if (cachedKey !== undefined) return Promise.resolve(cachedKey);
	inflightKey ??= (async () => {
		const executable = await findWorkbuddyAppExecutable();
		if (executable === undefined) return undefined;
		const payload = await fetchAtRestKeyPayload(executable);
		const key = deriveAtRestKey(payload);
		cachedKey = key;
		return key;
	})().finally(() => {
		inflightKey = undefined;
	});
	return inflightKey;
}

/** Drop the cached key; tests and diagnostics only. */
export function clearAtRestKeyCache(): void {
	cachedKey = undefined;
	inflightKey = undefined;
}
