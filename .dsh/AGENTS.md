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

`settings.yaml`'s hand-declared routes get **none** of pi-ai's
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
