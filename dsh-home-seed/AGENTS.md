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
