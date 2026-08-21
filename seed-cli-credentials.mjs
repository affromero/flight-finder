#!/usr/bin/env node
// Keep whichever CLI credential is further along in its rotation.
//
// Both CLIs mint a new refresh token on every OAuth refresh and the server
// retires the previous one, so an older copy is not merely stale — it is dead,
// and restoring it locks the container out until someone pastes fresh
// credentials. The host mount is read-only and can never receive a rotation,
// so the entrypoint's directory overlay would hand back a retired token every
// restart. This runs after that overlay with the pre-overlay credential as the
// candidate: whichever generation is newer wins, and nothing is ever deleted.
//
// A JSON parse plus a provider-specific timestamp is the whole comparison,
// which no POSIX shell can do honestly and jq is not in this image.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const [provider, candidatePath, runtimePath] = process.argv.slice(2);
if (!provider || !candidatePath || !runtimePath) {
  console.error("usage: seed-cli-credentials.mjs <provider> <candidate> <runtime>");
  process.exit(2);
}

/** How far along a credentials file is in its rotation, or -1 when unreadable. */
function generation(contents) {
  try {
    const parsed = JSON.parse(contents);
    if (provider === "claude") {
      const expiry = parsed?.claudeAiOauth?.refreshTokenExpiresAt;
      return typeof expiry === "number" ? expiry : -1;
    }
    const refreshed =
      typeof parsed?.last_refresh === "string" ? Date.parse(parsed.last_refresh) : Number.NaN;
    return Number.isNaN(refreshed) ? -1 : refreshed;
  } catch {
    return -1;
  }
}

function read(pathname) {
  try {
    return readFileSync(pathname, "utf8");
  } catch {
    return null;
  }
}

const candidate = read(candidatePath);
if (!candidate || !candidate.trim()) process.exit(0);

const runtime = read(runtimePath);
if (runtime !== null && generation(runtime) >= generation(candidate)) {
  // What is on disk is at least as new — the overlay did not cost us anything.
  process.exit(0);
}
if (generation(candidate) < 0) process.exit(0); // Never install an unreadable file.

if (!existsSync(dirname(runtimePath))) mkdirSync(dirname(runtimePath), { recursive: true });
const temporary = `${runtimePath}.${randomUUID()}.tmp`;
writeFileSync(temporary, candidate, { mode: 0o600 });
renameSync(temporary, runtimePath);
console.log(`[setup] Restored the newer ${provider} credentials the host copy would have replaced`);
