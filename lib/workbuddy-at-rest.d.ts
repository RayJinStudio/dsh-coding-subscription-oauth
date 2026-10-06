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
/** A `{$wbEncrypted:1,envelope}` field wrapper, the only shape this module opens. */
export interface WorkBuddyEncryptedField {
    $wbEncrypted: 1;
    envelope: string;
}
/** Env override pointing at the WorkBuddy desktop executable. */
export declare const WORKBUDDY_APP_EXECUTABLE_ENV = "WORKBUDDY_APP_EXECUTABLE";
/** Whether a value is the app's encrypted-field wrapper. */
export declare function isEncryptedFieldWrapper(value: unknown): value is WorkBuddyEncryptedField;
/**
 * The at-rest key id for a derived 32-byte key: the first 16 hex characters of
 * its SHA-256. Checked against the envelope's own `keyId`, so a mismatched key
 * fails loudly instead of returning garbage.
 */
export declare function deriveAtRestKeyId(key: Buffer): string;
/**
 * Derive the 32-byte field key from the app's key payload JSON.
 *
 * The app hashes the payload's base64 STRING — not its decoded bytes — so the
 * same spelling is required here; hashing the decoded secret would produce a
 * different key and every field would fail to open.
 */
export declare function deriveAtRestKey(payloadJson: string): Buffer;
/**
 * Open one encrypted field with a derived key and return its plaintext.
 *
 * Throws when the envelope is malformed, belongs to another key, or fails
 * authentication — a GCM tag mismatch is the signal that the transcript or the
 * key is wrong, and it must never degrade into a truncated token.
 */
export declare function openEncryptedField(field: WorkBuddyEncryptedField, key: Buffer): string;
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
export declare function macosBundleExecutable(bundle: string): string | undefined;
/** Whether a bundle identifies itself as the WorkBuddy desktop app. */
export declare function isWorkbuddyBundle(bundle: string): boolean;
/**
 * Bundles of the desktop app found one level BELOW a macOS applications
 * directory, each confirmed by {@link isWorkbuddyBundle} before use.
 *
 * A missing or unreadable parent is the normal case, not an error.
 */
export declare function macosNestedAppBundles(parent: string): string[];
/**
 * Candidate paths of the WorkBuddy desktop executable, in probe order.
 *
 * `win32.join` rather than the host's `join` on the Windows branch: those paths
 * are Windows paths by construction, and `path.join` follows the RUNNING
 * platform, so a POSIX host would insert `/` separators that never exist.
 */
export declare function workbuddyAppExecutableCandidates(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv, readBundleExecutable?: (bundle: string) => string | undefined): string[];
/**
 * The path inside a `DisplayIcon`/`InstallLocation` value, unquoted.
 *
 * Registry data may be quoted (`"D:\app\WorkBuddy.exe",0`) or bare. Only a
 * leading quote is treated as quoting: a bare `C:\dir\a"b.exe` is a real (if
 * unusual) filename and must not be truncated at the quote.
 */
export declare function stripRegistryQuotes(value: string): string | undefined;
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
export declare function normalizeRegistryExecutable(value: string): string | undefined;
/** Parse `reg query` output for the value that names the installed executable. */
export declare function registryExecutableFromQuery(output: string): string | undefined;
/**
 * The `WorkBuddy.exe` under an `InstallLocation`-style registry directory.
 *
 * `win32.join` for the reason given on {@link workbuddyAppExecutableCandidates}:
 * the separator is fixed by the DATA, not by the host.
 */
export declare function registryInstallLocationFromQuery(output: string): string | undefined;
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
export declare function windowsRegistryAppExecutable(query?: (args: readonly string[]) => Promise<string | undefined>): Promise<string | undefined>;
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
export declare function findWorkbuddyAppExecutable(options?: FindWorkBuddyExecutableOptions): Promise<string | undefined>;
/**
 * Ask the installed desktop app for its key payload by running its own binary
 * as plain Node (`ELECTRON_RUN_AS_NODE`) and calling the native binding.
 *
 * The binding is the app's own public surface for this value, so the plugin
 * never carries a copy of a build-specific constant: it asks the very build that
 * wrote the file. The child is given no stdin and a hard timeout, and only its
 * stdout is read.
 */
export declare function fetchAtRestKeyPayload(executable: string): Promise<string>;
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
export declare function readAtRestKey(): Promise<Buffer | undefined>;
/** Drop the cached key; tests and diagnostics only. */
export declare function clearAtRestKeyCache(): void;
//# sourceMappingURL=workbuddy-at-rest.d.ts.map