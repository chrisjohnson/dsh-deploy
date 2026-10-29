# Lab smoke results

lab `kan4` on :3099, started 2026-10-29T04:22:41.427Z

**12 PASS, 1 FAIL, 0 SKIP**

| module | check | status | seconds | detail |
| --- | --- | --- | --- | --- |
| sessions | find cleanly-ended copied sessions | PASS | 7.1 | 26 candidates (24 still in the old format) |
| sessions | reopen 4 of them (old-format ones convert on disk) | FAIL | 10.7 | 'Adjust big-moe context to 512k' (session-009cb19e-bf9e-4f99-8d2e-390b6dc3894d) logged: error: Failed to load resource: the server responded with a status of 404 (Not Found) [screenshot: /tmp/dsh-lab-kan4/kan4/.lab/smoke/shots/FAIL-sessions-reopen_4_of_them_old_format_ones_convert.png] |
| continue-kicker | start a long turn and kill the server in the middle of it | PASS | 3.7 | SIGKILL mid-stream; kept session-a1e081e3, pruned 1 leftover session(s) from earlier runs |
| continue-kicker | start the lab again | PASS | 2.3 | running again, boot verification clean |
| continue-kicker | reopening the session sends exactly one kick, and no more | PASS | 75.2 | exactly 1 kick in session-a1e081e3… (turn ends: interrupted), none in the next 75 s |
| kanban-recovery | lab route with a 48-token output budget is mounted under the implementer | PASS | 2.9 | continue-kicker 0.3.0 mounted with its kick service; lab restarted on the 48-token route |
| kanban-recovery | capabilities reports the kick service | PASS | 0.0 | continueKicker=true worktree=true |
| kanban-recovery | a halted implement turn is kicked by the engine and the ticket stays In flight | PASS | 58.7 | 3 auto_recovered events (max-tokens, max-tokens, max-tokens) over 58 In-flight samples, parked as 'turn failed in implement: max-tokens' |
| kanban-recovery | the session carries exactly maxConsecutiveKicks kicks and no duplicates | PASS | 0.0 | 3 kicks, 4 turn ends (4 halts) in session session-4ddb013c-906c-43f7-8902-0da4e015c27e |
| kanban-recovery | the ticket parks with the original halt once the guard declines | PASS | 0.0 | parked: turn failed in implement: max-tokens |
| kanban-recovery | degraded: with continue-kicker unmounted the ticket parks directly | PASS | 2.9 | lab restarted with the continue-kicker bundle removed |
| kanban-recovery | degraded: capabilities says the service is absent | PASS | 0.0 | continueKicker=false |
| kanban-recovery | degraded: one halt, no kicks, straight to Needs attention | PASS | 90.1 | parked: turn failed in implement: max-tokens, zero auto_recovered events |
