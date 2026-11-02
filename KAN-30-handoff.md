# KAN-30 handoff — service fingerprint for the pre-restart check

Production `dsh` service, unchanged by the KAN-30 build (read-only fingerprint,
taken before the build started and re-verified at pin time):

- `MainPID=2975411`
- `ActiveEnterTimestamp=Mon 2026-11-02 18:06:44 UTC`
- `InvocationID=d7307f0871304010b5b6db3719ab389d`

The `done_when` for `service-untouched` is satisfied when
`systemctl status dsh --no-pager` still shows this MainPID and
ActiveEnterTimestamp. The release takes effect only after a planned restart
(`sudo systemctl restart dsh`), which is a human step and is deliberately never
covered by a grant.
