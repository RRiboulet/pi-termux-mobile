/**
 * Builds android/app/src/main/assets/rootfs.bin: the Termux userland the app runs.
 *
 *   node scripts/package-rootfs.ts
 *
 * Resolves PACKAGES and their dependencies from the aarch64 Termux index, downloads each .deb, checks its SHA-256
 * against the index, extracts it without maintainer scripts, and rewrites the prefix `/data/data/com.termux` to
 * `/data/data/<applicationId>` in every file and symlink. Both are the same length, so ELF binaries keep their layout.
 * Symlinks into the prefix become relative; dangling ones are removed (the device's tar fails on them). Hard links
 * are stored as copies (Android forbids hard links in app data). Needs `dpkg`, `dpkg-deb`, and GNU `tar`.
 *
 * The applicationId is read from android/app/build.gradle, so the prefix can never drift from the package name.
 *
 * Provenance: the dependency resolution, the SHA-256 check and the prefix rewrite are ported from
 * https://github.com/badlogic/pi-termux-mobile (scripts/package-rootfs.py, MIT) and
 * https://github.com/picassio/pi-phone (scripts/package-rootfs.ts, MIT). The equal-length prefix rewrite, the
 * dangling-symlink removal and the hard-link handling come from pi-phone.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const REPO = "https://packages.termux.dev/apt/termux-main/";
const TERMUX = "/data/data/com.termux";
const ROOT = resolve(import.meta.dirname, "..");
const ASSETS = join(ROOT, "android/app/src/main/assets");
const BUILD_GRADLE = join(ROOT, "android/app/build.gradle");
const INDEX_LOCK = join(ROOT, "scripts/termux-index.lock");

/**
 * The Termux index is the whole trust root: the per-package SHA-256 is read from the same index the packages come
 * from, so the checks prove index/deb consistency and never index authenticity. Termux signs the index (InRelease),
 * but verifying that needs a pinned Termux key in this repository, which is a decision of its own.
 *
 * Until then, the index is pinned here: a lock file holds the hash of the index the build expects. The index moving is
 * then a change to a committed file, reviewed like any other, instead of a silent upgrade of the binaries that ship
 * inside the APK. Run with --update-index-lock to move it deliberately, and look at what the diff says.
 */
interface IndexLock {
    indexSha256: string;
    packages: Record<string, string>;
}

function readIndexLock(): IndexLock | undefined {
    if (!existsSync(INDEX_LOCK)) {
        return undefined;
    }

    return JSON.parse(readFileSync(INDEX_LOCK, "utf8")) as IndexLock;
}

function writeIndexLock(lock: IndexLock): void {
    writeFileSync(INDEX_LOCK, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * The package the app installs as. The prefix rewrite targets it, so it must be exactly as long as `com.termux`.
 *
 * Every `applicationId` in the file is collected, not just the first: a commented-out or product-flavour override
 * further down would otherwise silently change which prefix this script targets.
 */
function applicationId(): string {
    const gradle = readFileSync(BUILD_GRADLE, "utf8");
    const ids = [...gradle.matchAll(/^\s*applicationId\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]!);

    if (ids.length === 0) {
        throw new Error("no applicationId in android/app/build.gradle");
    }

    if (ids.length > 1) {
        throw new Error(
            `android/app/build.gradle sets ${ids.length} applicationIds (${ids.join(", ")}). ` +
                "This script cannot tell which one the APK installs as; leave exactly one.",
        );
    }

    return ids[0]!;
}

const APP_ID = applicationId();
const APP = `/data/data/${APP_ID}`;

/** What the agent and the server need; dependencies are added from the index. */
const PACKAGES = [
    // The floor the runtime asks for: runtime/package.json wants node >= 22.19.0, so a Termux index that drops
    // below it must fail the build here, not on the phone.
    "nodejs (>= 22.19)",
    "npm",
    "bash",
    "coreutils",
    "debianutils",
    "git",
    "ripgrep",
    "fd",
    "openssh",
    "util-linux",
    "ca-certificates",
    // Ships usr/share/LICENSES (GPL-2.0, GPL-3.0, Apache-2.0, ...). Without it every package's
    // usr/share/doc/<pkg>/copyright is a symlink to a file that is not there, and the licence notices of the
    // binaries we redistribute would be dropped from the APK.
    "termux-licenses",
    // sqlite3 on the phone, to read the durable store by hand when something looks wrong.
    "sqlite",
];

/** Checked after extraction: the runtime is useless without these. */
const REQUIRED = [
    "usr/bin/node",
    "usr/bin/bash",
    // node falls back to /usr/bin/sh when it needs a shell, and every `#!/usr/bin/env ...` script needs env.
    "usr/bin/sh",
    "usr/bin/env",
    "usr/bin/git",
    "usr/bin/rg",
    "usr/bin/fd",
    "usr/bin/ssh",
    "usr/lib/node_modules/npm/bin/npm-cli.js",
    "usr/etc/tls/cert.pem",
    // PiService preloads it so `#!/usr/bin/env` scripts run, and every child exec of bash/git/rg goes through it.
    "usr/lib/libtermux-exec-ld-preload.so",
    // The licence texts of the binaries we redistribute, and the per-package notices that point at them.
    "usr/share/LICENSES/GPL-3.0.txt",
    "usr/share/LICENSES/GPL-2.0.txt",
    "usr/share/LICENSES/Apache-2.0.txt",
];

if (TERMUX.length !== APP.length) {
    throw new Error(
        `the applicationId must be exactly ${TERMUX.length - "/data/data/".length} characters, like "com.termux": ` +
            `"${APP_ID}" gives ${APP.length} and "com.termux" gives ${TERMUX.length}. The rewrite patches the prefix ` +
            "in place, so the two must be the same length. Pick a 10-character id (e.g. \"app.pidabl\"), or keep " +
            "\"com.termux\".",
    );
}

/** The build host needs these; a missing one must fail before the 200 MB download, not after it. */
function requireTools(): void {
    for (const tool of ["dpkg", "dpkg-deb", "tar", "gzip"]) {
        try {
            execFileSync("which", [tool], { stdio: "ignore" });
        } catch {
            throw new Error(`${tool} is required to build the rootfs (see the README's Build section)`);
        }
    }

    // --hard-dereference is GNU tar only; bsdtar (macOS) fails at the very last step of the build.
    try {
        execFileSync("tar", ["--hard-dereference", "--version"], { stdio: "ignore" });
    } catch {
        throw new Error("GNU tar is required: --hard-dereference is not supported by this tar");
    }
}

type Fields = Record<string, string>;

async function download(url: string): Promise<Buffer> {
    // A half-open connection would hang the build forever with no output; name the URL when it does.
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });

    if (!response.ok) {
        throw new Error(`GET ${url}: HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
}

function parseIndex(text: string): Map<string, Fields> {
    const packages = new Map<string, Fields>();

    for (const paragraph of text.split("\n\n")) {
        const fields: Fields = {};

        for (const line of paragraph.split("\n")) {
            const match = /^([\w-]+): (.*)$/.exec(line);

            if (match !== null) {
                fields[match[1]!] = match[2]!;
            }
        }

        if (fields.Package !== undefined) {
            // The live index carries some names twice, with different versions (poppler, libvips, gegl, ...). Keep the
            // newer one, decided by dpkg's comparison, not by whichever paragraph happened to come last.
            const existing = packages.get(fields.Package);

            if (existing === undefined || newerVersion(fields.Version!, existing.Version!)) {
                packages.set(fields.Package, fields);
            }
        }
    }

    return packages;
}

/** Whether `a` is a newer version than `b`, by dpkg's rules. */
function newerVersion(a: string, b: string): boolean {
    try {
        execFileSync("dpkg", ["--compare-versions", a, "gt", b]);

        return true;
    } catch {
        return false;
    }
}

/** Virtual packages: a name a package Provides but does not exist under. Depending on one needs a real provider. */
function virtualProviders(index: Map<string, Fields>): Map<string, string[]> {
    const providers = new Map<string, string[]>();

    for (const [name, fields] of index) {
        for (const provided of (fields.Provides ?? "").split(",")) {
            const virtual = provided.trim().split(" ").filter((part) => part !== "").pop();

            if (virtual === undefined || virtual === "") {
                continue;
            }

            providers.set(virtual, [...(providers.get(virtual) ?? []), name]);
        }
    }

    return providers;
}

function versionSatisfies(version: string, operator: string, wanted: string): boolean {
    try {
        execFileSync("dpkg", ["--compare-versions", version, operator, wanted]);

        return true;
    } catch (error) {
        // dpkg exits 1 when the versions do not satisfy the constraint, and that is the only "no" here. Anything else
        // (dpkg missing, bad arguments) is a broken toolchain, not a version mismatch, and must not be read as "no".
        const status = (error as { status?: number | null }).status;

        if (status === 1) {
            return false;
        }

        throw new Error(
            `dpkg --compare-versions ${version} ${operator} ${wanted} failed (${String(error)}). ` +
                "The build host needs a working dpkg; see the README's Build section.",
        );
    }
}

function resolvePackages(index: Map<string, Fields>): Map<string, Fields> {
    const selected = new Map<string, Fields>();
    const virtual = virtualProviders(index);

    const add = (expression: string): void => {
        for (const alternative of expression.split("|")) {
            const match = /^\s*([\w+.-]+)(?::\w+)?(?:\s*\((<<|<=|=|>=|>>)\s*([^)]+)\))?\s*$/.exec(alternative);

            if (match === null) {
                throw new Error(`Unsupported dependency: ${expression}`);
            }

            const [, name, operator, wanted] = match;
            const fields = index.get(name!);

            if (fields === undefined) {
                // A name that no package carries is either a virtual package or a typo. Say which, instead of
                // "No package satisfies" later on.
                if (virtual.has(name!)) {
                    throw new Error(
                        `"${name}" is a virtual package provided by ${virtual.get(name!)!.join(", ")}. ` +
                            "Add one of those to PACKAGES, or pick a real package.",
                    );
                }

                continue;
            }

            if (operator !== undefined && !versionSatisfies(fields.Version!, operator, wanted!.trim())) {
                continue;
            }

            if (selected.has(name!)) {
                return;
            }

            selected.set(name!, fields);

            for (const field of ["Pre-Depends", "Depends"]) {
                for (const dependency of (fields[field] ?? "").split(",")) {
                    if (dependency.trim() !== "") {
                        add(dependency);
                    }
                }
            }

            return;
        }

        throw new Error(`No package satisfies: ${expression}`);
    };

    for (const name of PACKAGES) {
        add(name);
    }

    return selected;
}

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        yield path;

        if (entry.isDirectory()) {
            yield* walk(path);
        }
    }
}

/** Rewrites the prefix in files and symlinks under `files` (the extracted `.../com.termux/files`). */
function rewritePrefix(files: string): { files: number; links: number; dangling: string[]; kept: string[] } {
    const from = Buffer.from(TERMUX);
    const to = Buffer.from(APP);
    let patchedFiles = 0;
    let patchedLinks = 0;
    const links: string[] = [];

    for (const path of walk(files)) {
        const stat = lstatSync(path);

        if (stat.isSymbolicLink()) {
            links.push(path);
        } else if (stat.isFile()) {
            const data = readFileSync(path);
            let at = data.indexOf(from);

            if (at === -1) {
                continue;
            }

            while (at !== -1) {
                to.copy(data, at);
                at = data.indexOf(from, at + from.length);
            }

            // Some files ship read-only.
            chmodSync(path, stat.mode | 0o200);
            writeFileSync(path, data);
            chmodSync(path, stat.mode);
            patchedFiles++;
        }
    }

    // Links last: their targets must be in place to tell which dangle.
    const appFiles = `${APP}/files/`;
    const dangling: string[] = [];
    const kept: string[] = [];

    for (const path of links) {
        let target = readlinkSync(path).replaceAll(TERMUX, APP);

        if (target.startsWith(appFiles)) {
            target = relative(dirname(path), join(files, target.slice(appFiles.length))) || ".";
        }

        unlinkSync(path);
        symlinkSync(target, path);
        patchedLinks++;
    }

    for (const path of links) {
        const target = readlinkSync(path);

        // A link is judged against the DEVICE's namespace, not the build host's: an absolute target that exists only
        // on Android (/system/bin/sh, or the app's own data directory) is valid there and must be kept, even though
        // existsSync() on the build machine cannot see it. Only a relative link that does not resolve inside the
        // extracted tree is really broken -- and the device's tar fails on those.
        if (target.startsWith("/")) {
            kept.push(relative(files, path));
            continue;
        }

        if (!existsSync(path)) {
            dangling.push(relative(files, path));
            unlinkSync(path);
        }
    }

    return { files: patchedFiles, links: patchedLinks, dangling, kept };
}

/**
 * The one invariant that matters: no file in the tree may still point at the old prefix. A leftover path is a runtime
 * that half works -- the libraries load, and the shebangs and the global prefix do not.
 */
function assertNoOldPrefix(files: string): void {
    const leftovers: string[] = [];

    for (const path of walk(files)) {
        if (!lstatSync(path).isFile()) {
            continue;
        }

        if (readFileSync(path).includes(TERMUX)) {
            leftovers.push(relative(files, path));
        }
    }

    if (leftovers.length > 0) {
        throw new Error(
            `${leftovers.length} files still contain "${TERMUX}" after the rewrite: ${leftovers.slice(0, 5).join(", ")}` +
                (leftovers.length > 5 ? ", ..." : ""),
        );
    }
}

/**
 * The rewrite is format-blind: it patches bytes wherever the prefix appears, and inside a gzip member that would
 * corrupt the stream. Today the prefix happens to be encoded as back-references, so nothing breaks -- but "happens to"
 * is not a property, and nothing else here would notice a corrupt member. So check them: gzip -t verifies every
 * member's CRC and length.
 */
function assertCompressedFilesIntact(files: string): void {
    try {
        execFileSync("sh", ["-c", `find "$1" -name '*.gz' -type f -print0 | xargs -0 -r gzip -t`, "sh", files], {
            stdio: ["ignore", "ignore", "pipe"],
        });
    } catch (error) {
        throw new Error(`a compressed file in the rootfs did not survive the rewrite: ${String(error)}`);
    }
}

/** Symlinked directories are not walked, so their contents are neither patched nor archived. Say so out loud. */
function reportSymlinkedDirectories(files: string): string[] {
    const found: string[] = [];

    for (const path of walk(files)) {
        if (lstatSync(path).isSymbolicLink() && existsSync(path) && statSync(path).isDirectory()) {
            found.push(relative(files, path));
        }
    }

    return found;
}

/**
 * Trees nobody needs on a phone. usr/include is 12.9 MB of headers nothing compiles against, usr/share/man and
 * usr/share/info are documentation, and usr/libexec/installed-tests holds the packages' own test binaries.
 * usr/share/doc is KEPT: its copyright symlinks are the per-package notices of the binaries we redistribute.
 */
const PRUNED = ["usr/include", "usr/share/man", "usr/share/info", "usr/libexec/installed-tests"];

function prune(files: string): string[] {
    const removed: string[] = [];

    for (const path of PRUNED) {
        const target = join(files, path);

        if (existsSync(target)) {
            rmSync(target, { recursive: true, force: true });
            removed.push(path);
        }
    }

    return removed;
}

/**
 * The archive that ships is what has to be checked, not the tree it came from: a truncated or half-written file
 * would otherwise be accepted, installed on the phone, and the installer tolerates a partial extraction as long as
 * usr/bin/node is there.
 */
function assertArchiveIntact(archive: string, required: string[]): void {
    try {
        execFileSync("gzip", ["-t", archive], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
        throw new Error(`the produced archive is not a valid gzip stream: ${String(error)}`);
    }

    let listing: string;

    try {
        listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
        throw new Error(`the produced archive is not a readable tar: ${String(error)}`);
    }

    const names = new Set(listing.split("\n").filter((line) => line !== ""));

    for (const path of required) {
        // REQUIRED names are already relative to the prefix ("usr/bin/node"), which is how the archive lists them.
        if (!names.has(path)) {
            throw new Error(`the produced archive is missing ${path}`);
        }
    }
}

async function main(): Promise<void> {
    requireTools();
    console.log(`prefix: ${TERMUX} -> ${APP}`);

    const indexBytes = await download(`${REPO}dists/stable/main/binary-aarch64/Packages.gz`);
    const indexSha256 = createHash("sha256").update(indexBytes).digest("hex");
    const index = parseIndex(gunzipSync(indexBytes).toString("utf8"));
    const selected = resolvePackages(index);
    const work = mkdtempSync(join(tmpdir(), "pi-termux-rootfs-"));
    const extracted = join(work, "root");
    const manifest: { package: string; version: string; sha256: string; filename: string }[] = [];

    // The pinned index. Either it is the one we expect, or the move has to be taken deliberately.
    const lock = readIndexLock();
    const resolved = Object.fromEntries([...selected].map(([name, fields]) => [name, fields.Version!]));

    if (lock === undefined) {
        writeIndexLock({ indexSha256, packages: resolved });
        console.log(`index lock written: ${indexSha256.slice(0, 12)}`);
    } else if (lock.indexSha256 !== indexSha256) {
        if (process.argv.includes("--update-index-lock")) {
            writeIndexLock({ indexSha256, packages: resolved });
            console.log(`index lock updated: ${lock.indexSha256.slice(0, 12)} -> ${indexSha256.slice(0, 12)}`);
        } else {
            const moved = Object.entries(resolved).filter(
                ([name, version]) => lock.packages[name] !== undefined && lock.packages[name] !== version,
            );
            const added = Object.keys(resolved).filter((name) => lock.packages[name] === undefined);

            throw new Error(
                `the Termux index changed (${lock.indexSha256.slice(0, 12)} -> ${indexSha256.slice(0, 12)}). ` +
                    (moved.length > 0 ? `Versions moved: ${moved.map(([n, v]) => `${n} ${lock.packages[n]} -> ${v}`).join(", ")}. ` : "") +
                    (added.length > 0 ? `New: ${added.join(", ")}. ` : "") +
                    "Review the change, then take it deliberately with: node scripts/package-rootfs.ts --update-index-lock",
            );
        }
    }

    mkdirSync(extracted);

    try {
        for (const [name, fields] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
            const data = await download(REPO + fields.Filename!);
            const sha256 = createHash("sha256").update(data).digest("hex");

            if (sha256 !== fields.SHA256) {
                throw new Error(`Checksum mismatch: ${name} ${fields.Version}`);
            }

            const deb = join(work, `${name}.deb`);

            writeFileSync(deb, data);
            execFileSync("dpkg-deb", ["--extract", deb, extracted]);
            rmSync(deb);
            manifest.push({ package: name, version: fields.Version!, sha256, filename: fields.Filename! });
            console.log(`${name} ${fields.Version}`);
        }

        const files = join(extracted, TERMUX.slice(1), "files");
        const rewritten = rewritePrefix(files);

        console.log(`prefix rewritten in ${rewritten.files} files and ${rewritten.links} symlinks`);

        if (rewritten.dangling.length > 0) {
            console.log(`removed ${rewritten.dangling.length} dangling symlinks: ${rewritten.dangling.join(", ")}`);
        }

        if (rewritten.kept.length > 0) {
            console.log(`kept ${rewritten.kept.length} symlinks with absolute targets: ${rewritten.kept.join(", ")}`);
        }

        for (const path of REQUIRED) {
            if (!existsSync(join(files, path))) {
                throw new Error(`Missing from the rootfs: ${path}`);
            }
        }

        const symlinkedDirectories = reportSymlinkedDirectories(files);

        if (symlinkedDirectories.length > 0) {
            console.log(`symlinked directories (not walked, so their contents are not patched): ${symlinkedDirectories.join(", ")}`);
        }

        assertNoOldPrefix(files);
        assertCompressedFilesIntact(files);

        const pruned = prune(files);

        if (pruned.length > 0) {
            console.log(`pruned ${pruned.join(", ")}`);
        }

        mkdirSync(ASSETS, { recursive: true });
        // Reproducible: no owner, no group, no mtime, sorted names, and a gzip header without a name or a timestamp.
        // The payload fingerprint is taken over this archive, so a machine-dependent one would make the device
        // re-extract 200 MB for a byte-identical userland.
        // The paths are passed as arguments, not interpolated into the script.
        execFileSync(
            "sh",
            [
                "-c",
                'tar --hard-dereference --owner=0 --group=0 --numeric-owner --mtime=@0 --sort=name ' +
                    '-cf - -C "$1" usr | gzip -n > "$2"',
                "sh",
                files,
                join(ASSETS, "rootfs.bin"),
            ],
            { stdio: "inherit" },
        );

        assertArchiveIntact(join(ASSETS, "rootfs.bin"), REQUIRED);

        writeFileSync(
            join(ASSETS, "termux-packages.json"),
            `${JSON.stringify(
                {
                    applicationId: APP_ID,
                    prefix: APP,
                    index: indexSha256,
                    removedSymlinks: rewritten.dangling,
                    absoluteSymlinks: rewritten.kept,
                    symlinkedDirectories,
                    pruned,
                    packages: manifest,
                },
                null,
                2,
            )}\n`,
        );
        console.log(`rootfs.bin: ${selected.size} packages`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

await main();
