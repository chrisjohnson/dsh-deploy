# Environment notes (loaded every session)

You run inside a Docker container. `docker`/`docker compose` (socket
mounted) spawn **sibling** containers on the host daemon — not nested
inside your own container.

**Bind mounts**: `-v <src>:<dst>` resolves `<src>` on the HOST filesystem,
not your container's view. Translate your own `/work/...` to
`$HOST_WORK_DIR/...` first:
`-v "$HOST_WORK_DIR/proj:/data"` (right) vs `-v /work/proj:/data` (wrong —
resolves on host root). Named volumes (no leading `/`) need no
translation.

**Networking**: a sibling shares none of your network namespace;
`localhost` there isn't you.
- `--network docker_default` — reach another container by name
- `--add-host host.docker.internal:host-gateway` — reach a host-networked
  service (Linux Engine, not Docker Desktop; not automatic)
- `--network host` — give the sibling full host access

Verify from inside the spawned container (`docker exec ...`) — a wrong
mount or unreachable network still exits 0.

## Cross-repo work

Retry the specific op with `sandbox_permissions: danger-full-access` + a one-line
justification instead of restructuring workspaces — the retry itself raises the
prompt, don't ask in chat first. For a bounded multi-step chore elsewhere (edit,
commit, push), delegate to a subagent so it absorbs its own retries under one
approval instead of escalating call-by-call. No approver available: denial is final.

## Model list settings — re-verify on every backend swap

`settings.yaml`'s hand-declared routes (`local-ai-machine`,
`local-ai-machine-r9700`) get **none** of pi-ai's installed-catalog
defaults — `contextWindow`, `maxTokens`, `input`, `reasoningEfforts` all
silently assume the wrong thing (usually "unsupported"/"2x the real
size") unless declared explicitly. This has already caused real bugs:
wrong context-window sizing broke compaction, missing `input: [image]`
silently dropped screenshots, missing `reasoningEfforts` hid a working
reasoning model's effort selector entirely. **Whenever a role gets
reassigned to a different backend via `set-role.sh`, re-verify all four
for that role** — don't assume the previous backend's values still
apply.

How to verify each, against the backend's real port (`docker port
<container>`, or via litellm's `/model/info`):
- **contextWindow/maxTokens**: the build's own `docker-compose.yaml`
  `-c`/`-n` (llama.cpp) or `--max-model-len` (vLLM) flags — or trigger a
  real `ContextWindowExceededError` and read the true limit off it, the
  declared flag isn't always what's actually enforced (see Ornith v8 vs
  v9 in `settings.yaml`'s own history).
- **input**: does the build's compose file mount an `mmproj`/vision
  adapter, or is the backend a known vision-model family?
- **reasoningEfforts**: `curl <backend>/props | jq -r .chat_template`
  (llama.cpp) and grep for `reasoning_effort` vs `enable_thinking` vs
  neither — or for a non-running build, grep the checkpoint directly:
  `chat_template.jinja`/`chat_template.json` next to the weights (vLLM),
  or search the GGUF's raw bytes for the same strings (the string is
  embedded in `tokenizer.chat_template` metadata, not always in the
  first few MB of the file — search at least 20MB in). Three real
  outcomes, each needing different `settings.yaml` config:
  - **no match at all** → not a reasoning model, declare
    `reasoningEfforts: false` explicitly (don't just omit it — omitting
    also disables it, but `false` documents that it was checked, not
    forgotten).
  - **`enable_thinking` only, no `reasoning_effort`** → binary
    toggle, not graduated. Declare exactly two levels (`off`/one "on"
    level — offering low/medium/high here is cosmetic, the template
    can't tell them apart). Needs `compat.thinkingFormat: chat-template`
    **and** `chatTemplateKwargs.enable_thinking: {$var: thinking.enabled,
    omitWhenOff: true}` — either one alone is a silent no-op.
  - **`reasoning_effort` present** → read the template's own
    if/elif/else chain to find which strings it actually treats as
    distinct (don't assume `low`/`medium`/`high`/`xhigh` are all
    different — check for aliasing, and check what unrecognized values
    resolve to before trusting it won't error on a typo). Needs
    `compat.supportsReasoningEffort: true`.
  Either mechanism, verify it end-to-end after deploying: pick a
  non-default level in dsh's model picker and confirm the response
  actually changes (shorter/no `<think>` block for effort off, longer
  for higher effort) — a selector that shows levels but doesn't
  actually change backend behavior is worse than no selector at all.

