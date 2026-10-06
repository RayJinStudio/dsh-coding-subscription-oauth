/**
 * WorkBuddy auth: region classification, both document shapes, the encrypted
 * gate, candidate ranking, and the read-only-desktop / own-copy write policy.
 */

import { createCipheriv } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAtRestKey, deriveAtRestKeyId, openEncryptedField } from "../src/workbuddy-at-rest.ts";
import {
	defaultDesktopAuthDirs,
	ENCRYPTED_CREDENTIAL_CODE,
	expiryToMs,
	hasEncryptedCredentialFields,
	isWorkBuddyEncryptedCredentialError,
	parseWorkBuddyAuth,
	WORKBUDDY_AUTH_FILENAME,
	WorkBuddyCredentialStore,
	workbuddyAccountId,
	workbuddyOwnAuthPath,
	workbuddyRegionOf,
} from "../src/workbuddy-auth.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "workbuddy-auth-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** A plaintext desktop document in the nested shape the app writes. */
function desktopDocument(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		auth: {
			accessToken: "access-desktop",
			refreshToken: "refresh-desktop",
			expiresAt: Date.now() + 3_600_000,
			refreshExpiresAt: Date.now() + 86_400_000,
			lastRefreshTime: Date.now() - 1_000,
			domain: "www.workbuddy.cn",
			...overrides,
		},
		account: { uid: "uid-1", uin: "100000000001", nickname: "Buddy" },
	});
}

describe("workbuddyRegionOf", () => {
	it("classifies both international brand domains, and their subdomains, as global", () => {
		for (const domain of ["workbuddy.ai", "www.workbuddy.ai", "codebuddy.ai", "api.codebuddy.ai"]) {
			expect(workbuddyRegionOf(domain)).toBe("global");
		}
	});

	it("is a total predicate: anything else, including the empty string, is cn", () => {
		for (const domain of ["www.workbuddy.cn", "www.codebuddy.cn", "copilot.tencent.com", "", "  ", "example.com"]) {
			expect(workbuddyRegionOf(domain)).toBe("cn");
		}
	});

	it("is case- and whitespace-insensitive", () => {
		expect(workbuddyRegionOf("  WWW.WorkBuddy.AI  ")).toBe("global");
	});
});

describe("defaultDesktopAuthDirs", () => {
	// The app's `getSharedAuthDirectory()` has exactly one Windows location and
	// never reads %APPDATA%\Roaming. A second candidate was carried over from
	// the reference implementation; it showed up to every user as a permanent
	// `not readable (missing)` row, so this pins the single-location contract.
	//
	// Expectations use `join`, not `path.win32.join`, deliberately: these paths
	// come from a live env var at runtime, so `defaultDesktopAuthDirs` is right
	// to follow the host's separator. Driving it with `platform: "win32"` on a
	// POSIX host is a test-only simulation, and matching it with `win32.join`
	// would assert a shape production never produces on that host.
	it("probes exactly one Windows directory, under Local, never Roaming", () => {
		expect(
			defaultDesktopAuthDirs("win32", "C:\\Users\\t", {
				LOCALAPPDATA: "D:/Local",
				APPDATA: "D:/Roaming",
			}),
		).toEqual([join("D:/Local", "CodeBuddyExtension", "Data", "Public", "auth")]);
	});

	it("still honors the env location first, falling back to <home>\\AppData\\Local", () => {
		// The redirect protection: a machine whose LOCALAPPDATA points elsewhere
		// must follow the variable, and one where it is unset or blank must still
		// resolve through the home-derived convention.
		const expected = join("C:/Users/t", "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth");
		for (const env of [{}, { LOCALAPPDATA: "   " }]) {
			expect(defaultDesktopAuthDirs("win32", "C:/Users/t", env)).toEqual([expected]);
		}
	});

	it("keeps the single macOS and Linux paths unchanged", () => {
		expect(defaultDesktopAuthDirs("darwin", "/Users/t", {})).toEqual([
			join("/Users/t", "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"),
		]);
		expect(defaultDesktopAuthDirs("linux", "/home/t", {})).toEqual([
			join("/home/t", ".config", "CodeBuddyExtension", "Data", "Public", "auth"),
		]);
		expect(defaultDesktopAuthDirs("linux", "/home/t", { XDG_CONFIG_HOME: "/cfg" })).toEqual([
			join("/cfg", "CodeBuddyExtension", "Data", "Public", "auth"),
		]);
	});
});

describe("expiryToMs", () => {
	it("passes milliseconds through, converts seconds, and zeroes non-positive input", () => {
		expect(expiryToMs(1_700_000_000_000)).toBe(1_700_000_000_000);
		expect(expiryToMs(1_700_000_000)).toBe(1_700_000_000_000);
		expect(expiryToMs(0)).toBe(0);
		expect(expiryToMs(-5)).toBe(0);
	});
});

describe("parseWorkBuddyAuth", () => {
	it("reads the nested document shape", () => {
		const credential = parseWorkBuddyAuth(desktopDocument(), "/tmp/a.info");
		expect(credential).toMatchObject({
			accessToken: "access-desktop",
			refreshToken: "refresh-desktop",
			domain: "www.workbuddy.cn",
			uid: "uid-1",
			uin: "100000000001",
			nickname: "Buddy",
			source: "desktop",
			filePath: "/tmp/a.info",
		});
	});

	it("reads the flat panel shape, where the document is both auth and identity", () => {
		const flat = JSON.stringify({
			accessToken: "access-flat",
			refreshToken: "refresh-flat",
			expiresAt: Date.now() + 1000,
			domain: "www.codebuddy.ai",
			uid: "uid-flat",
		});
		expect(parseWorkBuddyAuth(flat, "/tmp/flat.info")).toMatchObject({
			accessToken: "access-flat",
			domain: "www.codebuddy.ai",
			uid: "uid-flat",
		});
	});

	it("converts second-precision timestamps and tolerates absent optional fields", () => {
		const credential = parseWorkBuddyAuth(desktopDocument({ expiresAt: 1_700_000_000 }), "/tmp/a.info");
		expect(credential?.expiresAtMs).toBe(1_700_000_000_000);
	});

	it("returns undefined when there is no readable access token", () => {
		expect(parseWorkBuddyAuth("{}", "/tmp/a.info")).toBeUndefined();
		expect(parseWorkBuddyAuth(JSON.stringify({ auth: { accessToken: "" } }), "/tmp/a.info")).toBeUndefined();
		expect(parseWorkBuddyAuth("not json", "/tmp/a.info")).toBeUndefined();
		expect(parseWorkBuddyAuth("[]", "/tmp/a.info")).toBeUndefined();
	});

	it("never surfaces a half-decrypted credential when a wrapper cannot be opened", () => {
		const sealed = JSON.stringify({
			auth: { accessToken: { $wbEncrypted: 1, envelope: "!!not-base64-json!!" }, domain: "www.workbuddy.cn" },
			account: {},
		});
		expect(parseWorkBuddyAuth(sealed, "/tmp/a.info", Buffer.alloc(32))).toBeUndefined();
	});

	it("opens a genuinely sealed field with the derived key", () => {
		const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: "c2VjcmV0" }));
		const keyId = deriveAtRestKeyId(key);
		// Seal a value against the SAME AAD transcript the module builds. The
		// transcript is written out again here on purpose: it is the wire contract
		// with the desktop app, so an independent statement of it in the test is
		// what makes a silent change to either side fail loudly.
		const nonce = Buffer.alloc(12, 7);
		const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
		cipher.setAAD(
			Buffer.concat([
				Buffer.from("WB-AAD\0", "ascii"),
				Buffer.from([1]),
				Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from("WBEV1")]),
				Buffer.concat([Buffer.from([0, 0, 0, 6]), Buffer.from("sym-v1")]),
				Buffer.from([0, 0, 0, 3]),
				Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from(keyId)]),
				Buffer.from([2, 0, 0]),
			]),
		);
		const ciphertext = Buffer.concat([cipher.update("access-sealed", "utf8"), cipher.final()]);
		const field = {
			$wbEncrypted: 1 as const,
			envelope: Buffer.from(
				JSON.stringify({
					suite: 3,
					keyId,
					nonce: nonce.toString("base64"),
					authTag: cipher.getAuthTag().toString("base64"),
					ciphertext: ciphertext.toString("base64"),
				}),
			).toString("base64"),
		};
		// The module's own opener is the contract under test.
		expect(openEncryptedField(field, key)).toBe("access-sealed");
		const document = JSON.stringify({
			auth: { accessToken: field, refreshToken: "r", domain: "www.workbuddy.cn", expiresAt: 1_700_000_000 },
			account: { uin: "1" },
		});
		expect(parseWorkBuddyAuth(document, "/tmp/a.info", key)).toMatchObject({ accessToken: "access-sealed" });
	});
});

describe("hasEncryptedCredentialFields", () => {
	it("is false for a plaintext document, so no child process is spawned", () => {
		expect(hasEncryptedCredentialFields(desktopDocument())).toBe(false);
	});

	it("is true for each of the seven sealed field paths", () => {
		const wrapper = { $wbEncrypted: 1, envelope: "eA==" };
		for (const [scope, field] of [
			["auth", "accessToken"],
			["auth", "refreshToken"],
			["auth", "domain"],
			["account", "nickname"],
			["account", "uin"],
			["account", "uid"],
			["account", "enterpriseId"],
		] as const) {
			const document = JSON.stringify({ auth: { accessToken: "a" }, account: {}, [scope]: { [field]: wrapper } });
			expect(hasEncryptedCredentialFields(document)).toBe(true);
		}
	});

	it("is false for an unparseable document rather than guessing", () => {
		expect(hasEncryptedCredentialFields("{")).toBe(false);
	});

	it("does not treat a phoneNumber wrapper as needing the key", () => {
		const document = JSON.stringify({
			auth: { accessToken: "a" },
			account: { phoneNumber: { $wbEncrypted: 1, envelope: "eA==" } },
		});
		expect(hasEncryptedCredentialFields(document)).toBe(false);
	});
});

describe("workbuddyAccountId", () => {
	it("prefers uin, then uid, then nickname, and hashes stably", () => {
		const withUin = workbuddyAccountId({ uin: "u", uid: "i", nickname: "n" });
		expect(withUin).toBe(workbuddyAccountId({ uin: "u", uid: "other", nickname: "other" }));
		expect(withUin).toHaveLength(24);
		expect(workbuddyAccountId({ uid: "i", nickname: "n" })).not.toBe(withUin);
		// A blank identifier falls through rather than winning the chain, so it
		// lands on the same id as a document with no identifier at all.
		expect(workbuddyAccountId({ uin: "", uid: "", nickname: "" })).toBe(workbuddyAccountId({ uid: "" }));
		expect(workbuddyAccountId({ uin: "", uid: "real", nickname: "n" })).toBe(
			workbuddyAccountId({ uid: "real", nickname: "n" }),
		);
	});
});

describe("WorkBuddyCredentialStore", () => {
	const refresh = async () => ({ accessToken: "refreshed" });

	it("resolves the desktop credential and reports a signed-in status", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument());
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath: join(dir, "own.json"),
			refresh,
		});
		expect((await store.status()).state).toBe("signed-in");
		const credential = await store.resolve();
		expect(credential.accessToken).toBe("access-desktop");
	});

	it("prefers the live file over a newer-looking backup, whose expiry lies", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "workbuddy-desktop.info"),
			desktopDocument({ accessToken: "live", lastRefreshTime: Date.now() }),
		);
		// A revoked backup: far-future expiry, older issuance stamp.
		await writeFile(
			join(dir, "workbuddy-desktop.2020-01-01T00-00-00-000Z.1.a.info"),
			desktopDocument({
				accessToken: "backup",
				expiresAt: Date.now() + 10 * 365 * 24 * 3600 * 1000,
				lastRefreshTime: Date.now() - 86_400_000,
			}),
		);
		const store = new WorkBuddyCredentialStore({ authDirs: [dir], ownPath: join(dir, "own.json"), refresh });
		expect((await store.resolve()).accessToken).toBe("live");
	});

	it("reports an absent sign-in without throwing", async () => {
		const dir = await tempDir();
		const store = new WorkBuddyCredentialStore({ authDirs: [dir], ownPath: join(dir, "own.json"), refresh });
		expect(await store.status()).toEqual({ state: "signed-out" });
		await expect(store.resolve()).rejects.toThrow(/not signed in/iu);
	});

	it("reports the encrypted condition with its own error, not a plain sign-out", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "workbuddy-desktop.info"),
			JSON.stringify({
				auth: { accessToken: { $wbEncrypted: 1, envelope: "eA==" }, domain: "www.workbuddy.cn" },
				account: {},
			}),
		);
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath: join(dir, "own.json"),
			refresh,
			// No app available: the key must come back undefined, not throw.
			resolveAtRestKey: async () => undefined,
		});
		const failure = await store.resolve().catch((error: unknown) => error);
		expect(isWorkBuddyEncryptedCredentialError(failure)).toBe(true);
		expect((failure as { code: string }).code).toBe(ENCRYPTED_CREDENTIAL_CODE);
		// The advice must NOT be "sign in again", which cannot help.
		expect((failure as Error).message).toContain("WORKBUDDY_APP_EXECUTABLE");
		expect((failure as Error).message).not.toMatch(/sign in again in the WorkBuddy app/iu);
	});

	it("records a wrong-region file as a failure instead of silently skipping it", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument({ domain: "www.codebuddy.ai" }));
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath: join(dir, "own.json"),
			refresh,
			region: "cn",
		});
		const diagnosis = await store.diagnose();
		expect(diagnosis.failures.some((failure) => failure.reason === "wrong-region")).toBe(true);
		expect(diagnosis.tried).toContain(join(dir, "workbuddy-desktop.info"));
	});

	it("refreshes into its own copy and NEVER writes the desktop file", async () => {
		const dir = await tempDir();
		const desktopPath = join(dir, "workbuddy-desktop.info");
		const original = desktopDocument({ expiresAt: Date.now() - 1000 });
		await writeFile(desktopPath, original);
		const ownPath = join(dir, "own.json");
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath,
			refresh: async () => ({ accessToken: "rotated", expiresInSec: 3600 }),
		});
		const credential = await store.resolve();
		expect(credential.accessToken).toBe("rotated");
		expect(credential.source).toBe("dsh");
		// The vendor file is byte-identical: refreshes never touch it.
		expect(await readFile(desktopPath, "utf8")).toBe(original);
		const own = JSON.parse(await readFile(ownPath, "utf8")) as { version: number; credential: { accessToken: string } };
		expect(own.version).toBe(1);
		expect(own.credential.accessToken).toBe("rotated");
	});

	it("keeps serving a still-valid token when the refresh fails", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument({ expiresAt: Date.now() + 60_000 }));
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath: join(dir, "own.json"),
			// Inside the five-minute margin, so a refresh IS attempted.
			refresh: async () => {
				throw new Error("gateway down");
			},
		});
		expect((await store.resolve()).accessToken).toBe("access-desktop");
	});

	it("surfaces a failed refresh when the token is already expired", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument({ expiresAt: Date.now() - 1000 }));
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath: join(dir, "own.json"),
			refresh: async () => {
				throw new Error("gateway down");
			},
		});
		await expect(store.resolve()).rejects.toThrow(/refresh failed/iu);
	});

	it("surfaces a failed refresh for a FORCED invalidate even with time left", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument({ expiresAt: Date.now() + 3_600_000 }));
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath: join(dir, "own.json"),
			refresh: async () => {
				throw new Error("gateway down");
			},
		});
		// A plain resolve is happy to use the still-valid token...
		expect((await store.resolve()).accessToken).toBe("access-desktop");
		// ...but once upstream rejected it, the same token must not be handed back.
		await store.invalidateAccessToken();
		await expect(store.resolve()).rejects.toThrow(/refresh failed/iu);
	});

	it("single-flights concurrent refreshes", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument({ expiresAt: Date.now() - 1000 }));
		const rotate = vi.fn(async () => ({ accessToken: "rotated", expiresInSec: 3600 }));
		const store = new WorkBuddyCredentialStore({ authDirs: [dir], ownPath: join(dir, "own.json"), refresh: rotate });
		const results = await Promise.all([store.resolve(), store.resolve(), store.resolve()]);
		expect(rotate).toHaveBeenCalledTimes(1);
		expect(results.every((entry) => entry.accessToken === "rotated")).toBe(true);
	});

	it("logout removes only its own copies, leaving the desktop sign-in intact", async () => {
		const dir = await tempDir();
		const desktopPath = join(dir, "workbuddy-desktop.info");
		await writeFile(desktopPath, desktopDocument());
		const ownPath = join(dir, "own.json");
		await writeFile(ownPath, JSON.stringify({ version: 1, credential: { accessToken: "own" } }));
		const store = new WorkBuddyCredentialStore({ authDirs: [dir], ownPath, refresh });
		await store.logout();
		await expect(readFile(ownPath, "utf8")).rejects.toThrow();
		expect(await readFile(desktopPath, "utf8")).toContain("access-desktop");
		// The desktop sign-in still serves the account.
		expect((await store.resolve()).accessToken).toBe("access-desktop");
	});

	it("an explicit selection picks that account; an unknown one falls back", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument());
		const store = new WorkBuddyCredentialStore({ authDirs: [dir], ownPath: join(dir, "own.json"), refresh });
		const accounts = await store.accounts();
		expect(accounts).toHaveLength(1);
		store.selectAccount(accounts[0]?.id);
		expect(store.hasExplicitSelection()).toBe(true);
		expect((await store.resolve()).accessToken).toBe("access-desktop");
		// An id that no longer exists must not wedge the route.
		store.selectAccount("does-not-exist");
		expect((await store.resolve()).accessToken).toBe("access-desktop");
	});

	it("exposes the resolved credential through peek() for synchronous readers", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument());
		const store = new WorkBuddyCredentialStore({ authDirs: [dir], ownPath: join(dir, "own.json"), refresh });
		expect(store.peek()).toBeUndefined();
		await store.resolve();
		expect(store.peek()?.accessToken).toBe("access-desktop");
	});

	it("resolves the plugin-owned path beneath DSH_HOME", () => {
		// `resolveDshHome` returns an absolute, host-separator path, so the
		// expectation is built the same way: the contract is that the file lands
		// directly under DSH_HOME with the region in its name.
		const home = join(process.cwd(), "workbuddy-home-probe");
		expect(workbuddyOwnAuthPath("cn", home)).toBe(join(home, ".workbuddy-auth.cn.json"));
		expect(workbuddyOwnAuthPath("global", home)).toBe(join(home, ".workbuddy-auth.global.json"));
		expect(WORKBUDDY_AUTH_FILENAME).toBe(".workbuddy-auth.json");
	});
});
