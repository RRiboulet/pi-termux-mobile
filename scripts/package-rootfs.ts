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

/** The package the app installs as. The prefix rewrite targets it, so it must be exactly as long as `com.termux`. */
function applicationId(): string {
    const gradle = readFileSync(BUILD_GRADLE, "utf8");
    const match = /applicationId\s+['"]([^'"]+)['"]/.exec(gradle);

    if (match === null) {
        throw new Error("no applicationId in android/app/build.gradle");
    }

    return match[1]!;
}

const APP_ID = applicationId();
const APP = `/data/data/${APP_ID}`;

/** What the agent and the server need; dependencies are added from the index. */
const PACKAGES = [
    "nodejs",
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
    // sqlite3 on the phone, to read the durable store by hand when something looks wrong.
    "sqlite",
];

/** Checked after extraction: the runtime is useless without these. */
const REQUIRED = [
    "usr/bin/node",
    "usr/bin/bash",
    "usr/bin/git",
    "usr/bin/rg",
    "usr/bin/fd",
    "usr/bin/ssh",
    "usr/lib/node_modules/npm/bin/npm-cli.js",
    "usr/etc/tls/cert.pem",
    // PiService preloads it so `#!/usr/bin/env` scripts run, and every child exec of bash/git/rg goes through it.
    "usr/lib/libtermux-exec-ld-preload.so",
];

if (TERMUX.length !== APP.length) {
    throw new Error(
        `the app prefix must be as long as the Termux prefix: "${APP_ID}" gives ${APP.length}, ` +
            `"com.termux" gives ${TERMUX.length}. The rewrite patches the prefix in place, so the lengths must match.`,
    );
}

type Fields = Record<string, string>;

async function download(url: string): Promise<Buffer> {
    const response = await fetch(url);

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
            packages.set(fields.Package, fields);
        }
    }

    return packages;
}

function versionSatisfies(version: string, operator: string, wanted: string): boolean {
    try {
        execFileSync("dpkg", ["--compare-versions", version, operator, wanted]);

        return true;
    } catch {
        return false;
    }
}

function resolvePackages(index: Map<string, Fields>): Map<string, Fields> {
    const selected = new Map<string, Fields>();

    const add = (expression: string): void => {
        for (const alternative of expression.split("|")) {
            const match = /^\s*([\w+.-]+)(?::\w+)?(?:\s*\((<<|<=|=|>=|>>)\s*([^)]+)\))?\s*$/.exec(alternative);

            if (match === null) {
                throw new Error(`Unsupported dependency: ${expression}`);
            }

            const [, name, operator, wanted] = match;
            const fields = index.get(name!);

            if (fields === undefined) {
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
function rewritePrefix(files: string): { files: number; links: number; dangling: string[] } {
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
        if (!existsSync(path)) {
            dangling.push(relative(files, path));
            unlinkSync(path);
        }
    }

    return { files: patchedFiles, links: patchedLinks, dangling };
}

async function main(): Promise<void> {
    console.log(`prefix: ${TERMUX} -> ${APP}`);

    const index = parseIndex(
        gunzipSync(await download(`${REPO}dists/stable/main/binary-aarch64/Packages.gz`)).toString("utf8"),
    );
    const selected = resolvePackages(index);
    const work = mkdtempSync(join(tmpdir(), "pi-termux-rootfs-"));
    const extracted = join(work, "root");
    const manifest: { package: string; version: string; sha256: string; filename: string }[] = [];

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

        for (const path of REQUIRED) {
            if (!existsSync(join(files, path))) {
                throw new Error(`Missing from the rootfs: ${path}`);
            }
        }

        mkdirSync(ASSETS, { recursive: true });
        execFileSync("tar", ["--hard-dereference", "-czf", join(ASSETS, "rootfs.bin"), "-C", files, "usr"]);
        writeFileSync(join(ASSETS, "termux-packages.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`rootfs.bin: ${selected.size} packages`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

await main();
