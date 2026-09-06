#!/usr/bin/env node
// Mints a fresh GitHub App installation access token and prints it to
// stdout, nothing else. Used two ways: directly by the gh-CLI
// background refresh loop in docker-entrypoint.sh, and imported as the
// core of github-app-git-credential-helper.mjs. Never caches to disk —
// every invocation mints a genuinely fresh token, valid ~1h per GitHub's
// own (non-configurable) installation-token lifetime.
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "node:fs";

// dsh-deploy's docker-compose.yml always mounts the App private key at
// this fixed container path (read-only). It's the fallback in
// mintInstallationToken because the env var that names it is NOT
// reliably present in the process that needs it most (see there).
export const DEFAULT_PRIVATE_KEY_PATH = "/run/secrets/github-app-agent-key.pem";

export async function mintInstallationToken() {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  // GITHUB_APP_PRIVATE_KEY_PATH is absent from every agent session shell:
  // dsh's subprocess layer (dsh-subprocess's scrubbedParentEnv) strips any
  // env var whose name matches /KEY|PASSWORD|SECRET|TOKEN/i before
  // spawning a session's bash, and this name contains "KEY". The
  // entrypoint process (unscrubbed) keeps it — which is why the gh refresh
  // loop in docker-entrypoint.sh works — but the git credential helper is
  // invoked by git FROM the session shell, so it must not depend on the
  // var. The env var remains the override for a deployment that mounts
  // the key somewhere else; otherwise fall back to this image's own
  // fixed mount path.
  const privateKeyPath =
    process.env.GITHUB_APP_PRIVATE_KEY_PATH || DEFAULT_PRIVATE_KEY_PATH;

  if (!appId || !installationId) {
    throw new Error(
      "GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID must both be set"
    );
  }

  const privateKey = readFileSync(privateKeyPath, "utf8");
  const auth = createAppAuth({ appId, privateKey, installationId });
  const { token } = await auth({ type: "installation" });
  return token;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mintInstallationToken()
    .then((token) => process.stdout.write(token + "\n"))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
