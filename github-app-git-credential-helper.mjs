#!/usr/bin/env node
// Git credential helper: implements the protocol git expects
// (`git config credential.helper '/path/to/this get'`) — reads key=value
// pairs on stdin, writes username/password to stdout. `store`/`erase`
// are no-ops: the token is freshly minted per invocation, never written
// to disk by git itself, so there's nothing to store or erase.
//
// Only answers for host=github.com: this credential is an installation
// token for one specific GitHub App installation, so handing it to any
// other host git happens to ask about would be both useless and a leak.
// Anything else gets the protocol's "no credential available" response.
//
// Failure handling follows that same protocol: a helper that has nothing
// to give exits 0 with EMPTY stdout (never a crash) and lets git move on
// to its next fallback. Every failure path is diagnostic-logged to
// stderr (git surfaces helper stderr) so a broken setup is explainable
// without re-running git under GIT_TRACE.
//
// Token source, in order:
// 1. Mint a fresh installation token (github-app-token.mjs) — the
//    original design: genuinely fresh per git operation, valid ~1h.
//    Works from a session shell despite the env scrub via its
//    fixed-mount-path fallback (see that file).
// 2. Fall back to `gh auth token` — the entrypoint's background loop
//    refreshes ~/.config/gh/hosts.yml every 45 minutes in the unscrubbed
//    entrypoint environment, so even if minting itself is broken (key
//    file moved, network to github.com down at mint time, ...) this is
//    still a valid installation token.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mintInstallationToken } from "./github-app-token.mjs";

const execFileAsync = promisify(execFile);

if (process.argv[2] !== "get") {
  // store/erase are no-ops (see header).
  process.exit(0);
}

// Drain stdin — git sends the request as key=value lines, and we need the
// host field before answering.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = Buffer.concat(chunks).toString("utf8");

const hostMatch = request.match(/^host=(\S.*)$/m);
if (!hostMatch || hostMatch[1].trim() !== "github.com") {
  // Not github.com — "no credential available" per the protocol.
  process.exit(0);
}

let token = null;
let viaFallback = false;
const failures = [];

try {
  token = await mintInstallationToken();
} catch (err) {
  failures.push(`mint failed: ${err.message}`);
}

if (!token) {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 15000,
    });
    token = stdout.trim();
    viaFallback = Boolean(token);
  } catch (err) {
    failures.push(`gh fallback failed: ${err.message}`);
  }
}

if (!token) {
  for (const failure of failures) {
    process.stderr.write(`github-app-git-credential-helper: ${failure}\n`);
  }
  // "No credential available" per the protocol: empty stdout, exit 0.
  process.exit(0);
}

if (viaFallback) {
  for (const failure of failures) {
    process.stderr.write(`github-app-git-credential-helper: ${failure}\n`);
  }
  process.stderr.write(
    "github-app-git-credential-helper: serving gh auth token fallback\n"
  );
}

process.stdout.write(`username=x-access-token\npassword=${token}\n`);
