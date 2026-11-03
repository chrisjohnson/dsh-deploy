# Environment notes (loaded every session)

You run natively on the box (no Docker) - `$HOME`, bind mounts, and
sibling-container concerns from a Docker setup don't apply here. Your
filesystem view is the real host filesystem.

**Docker**: you're not in the `docker` group. `sudo docker`/`docker-compose`
`ps` / `logs` / `inspect` / `images` / `stats --no-stream` / `top` /
`restart` / `pull` work passwordlessly for inspecting or gently managing
the box's other containers (litellm, searxng, etc.); every other
subcommand (`exec`, `run`, `rm`, volume/network mutation, `system prune`,
bare `stats` without `--no-stream`) isn't permitted and will just fail
rather than prompt - ask the human instead of trying to work around it.

## Sudo from a DSH session

The `dsh` user's passwordless sudo rules are live and correct: they are declared
in `/home/dsh/local-ai-machine/configuration.nix` under
`security.sudo.extraRules` (the `docker`/`docker-compose` visibility commands,
`modelctl *`, `nixos-rebuild switch --flake /etc/nixos#local-ai-machine`,
`systemctl restart dsh`, and the git deploy steps run as `chris`). `sudo -n -l`
lists them all.

**They can only be triggered from a session running in Full access
(`danger-full-access`).** DSH's file sandbox (the Landlock launcher in
`@deepseek-ai/node-addon-system`) sets `no_new_privs` on every sandboxed child —
mandatory for an unprivileged Landlock restrict, and it is what neutralises
setuid escalation inside the sandbox. sudo 1.9.17 checks that flag before it ever
consults sudoers and refuses outright, so in a `read-only` or `workspace-write`
session the command is *unreachable*, not *unauthorised*:

```
$ sudo -n true
sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
sudo: If sudo is running in a container, you may need to adjust the container configuration to disable the flag.
$ echo $?   # 1 — and no prompt, no sudoers error, nothing to fix in sudoers
```

`/proc/self/status` → `NoNewPrivs` is the tell from a session that can read it
(`0` in a Full-access session, where sudo works; the file is itself unreadable
from inside a confined child, so there the sudo message above is the tell).

Getting a build or a session to Full access:

- **Kanban build sessions**: set the ticket's **write mode** to Full access.
  Plan and verify sessions are always `read-only` and can never run sudo,
  whatever the ticket says.
- **Interactive sessions**: the session's permission preset, or a per-call
  escalation a human approves. A sandboxed session cannot self-escalate, and the
  kanban plan-grant denylist word-denies `sudo`, so it can never be pre-granted
  into a build — a plan that needs sudo must ask for the write-mode change
  instead.

For your *own* containers, rootless Podman through its socket
(`CONTAINER_HOST=unix:///run/user/1002/podman/podman.sock`) works from a
sandboxed session and is the cheaper path; `sudo docker` for the box's containers
is the Full-access-only one.

## Podman: the container runtime for your own projects

You have a **rootless Podman instance owned by the `dsh` account**. That is the
sanctioned way to build and run containers here — you have no `docker` group
membership for your own workloads and don't need one.

Export once per session:

```sh
export CONTAINER_HOST=unix:///run/user/1002/podman/podman.sock
podman ps        # your containers only — never the box's docker ones
```

Local mode (`podman` with no `-H`) reaches the same storage, but fails when a
session is under `NoNewPrivs`; the socket works unconditionally.

- **It is not Docker.** Different daemon, different store — `sudo docker ps`
  will never list these, and rootful podman is disabled box-wide.
- **Bind loopback only:** `-p 127.0.0.1:<port>:<port>`. Dev builds carry no
  auth, and Caddy is the only intended public surface. Check what's bound
  before picking a port: `ss -ltn`.
- **Fully-qualify base images**: `FROM docker.io/library/rust:1.98-slim`, not
  `rust:1.98-slim`. NixOS writes `[[registry]]` blocks but never
  `unqualified-search-registries`, so short names cannot resolve at all — this
  is not fixable from config. `# syntax=` and `RUN --mount=type=cache` are both
  fine under buildah; don't strip them for "podman compatibility".
- **No supervision is intended here.** This box hosts experiments: sessions
  `run`/`stop`/`rm` containers freely, and released builds deploy elsewhere. So
  don't add systemd units to make a dev container "highly available".
- **Publishing a hostname is a deliberate human step** (a Caddy route plus
  `docker compose up -d --force-recreate caddy`). Neither is in the sudoers
  list, on purpose — ask, don't route around it.

`README.md` in this repo documents how that setup is actually wired.

## Git: never force-push or rewrite shared history

`git push --force`/`--force-with-lease`, `git reset --hard` on a branch
already pushed, squash-then-push, or any other rewrite of commits another
session might have built on — **stop and ask the human first**, even in a
repo where ordinary direct pushes to `main` are pre-authorized (like this
one). Direct-push authorization covers **fast-forward** commits only.

If your local branch has diverged from `origin/<branch>`, that divergence
is the signal to stop, not to force-push over it. Push to a new branch
name and ask, or describe the exact divergence and let the human decide.

## Model list settings — re-verify on every backend swap

`cordis.patch.yml`'s hand-declared `llm-pi-ai` routes get **none** of pi-ai's
installed-catalog defaults — `contextWindow`, `maxTokens`, `input`,
`reasoningEfforts` all silently assume the wrong thing unless declared
explicitly. **Whenever a role gets reassigned to a different backend via
`set-role.sh`, re-verify all four** — don't assume the previous backend's
values still apply.

- **contextWindow/maxTokens**: read the build's own `-c`/`-n`
  (llama.cpp) or `--max-model-len` (vLLM) flags, or trigger a real
  `ContextWindowExceededError` and read the true limit off it.
- **input**: does the build mount an `mmproj`/vision adapter?
- **reasoningEfforts**: `curl <backend>/props | jq -r .chat_template`
  and check for `reasoning_effort` vs `enable_thinking` vs neither.
  - No match → not a reasoning model, declare `reasoningEfforts: false`
    explicitly (documents it was checked, not forgotten).
  - `enable_thinking` only → binary toggle. Declare exactly two levels
    (`off`/one "on"). Needs `compat.thinkingFormat: chat-template` **and**
    `chatTemplateKwargs.enable_thinking: {$var: thinking.enabled,
    omitWhenOff: true}` — either alone is a silent no-op.
  - `reasoning_effort` present → read the template's own if/elif chain
    for which levels are actually distinct (don't assume
    low/medium/high/xhigh all differ). Needs
    `compat.supportsReasoningEffort: true`.
  - Either way, verify end-to-end: pick a non-default level and confirm
    the response actually changes.

## Web-profile plugins are browser React

Plugin client halves are **React for the Web GUI**: a `client*.{js,mjs}` file mounts into
the live composer/sidebar with no build step between the edit and a user's browser.
Plugin source lives in `chrisjohnson/dsh-plugins`; the root `AGENTS.md` covers the change
workflow and the Rules of Hooks trap specific to this renderer (standard state arrives as
hook-valued props).

Symptom worth recognising cold: a blank GUI region plus `Minified React error
#311`/`#310` in the console is a hook-count change in the plugin entry that owns that
slot (`slot entry crashed in '<slotKey>':`), not a core or infra fault.
