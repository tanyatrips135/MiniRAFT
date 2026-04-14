## Plan: Mini-RAFT Drawing Board Implementation

Build the project from scratch as a Dockerized 5-service system (gateway + 3 replicas + frontend) using Node.js, Express, ws, and vanilla JS. Implement a strict Mini-RAFT core in each replica (election, heartbeat, majority commit, term safety, catch-up sync), keep logs in-memory per requirements, route client strokes through the gateway to the current leader, and preserve WebSocket client sessions during failover. Validate with deterministic smoke tests and manual failover drills.

**Steps**
1. Phase 1 - Workspace and Runtime Scaffolding.
1. Create project structure exactly as required: /gateway, /replica1, /replica2, /replica3, /frontend, and root docker-compose.yml.
1. Initialize Node projects in each service folder with aligned Node version and scripts for start/dev/restart-safe shutdown.
1. Add shared environment contracts in each service (replica ID, replica peers, gateway callback URL, election timeout bounds, heartbeat interval) with defaults that match instructions.
1. Add graceful shutdown handlers in gateway and replicas so container restarts do not produce dangling sockets. This blocks failover and hot-reload reliability work.
1. Phase 2 - Replica Mini-RAFT Core (parallel per replica folder after first one is complete).
1. Implement identical RAFT engine in each replica (copy same code to replica1/2/3 folders to satisfy required bind-mounted independent directories), including state fields: nodeId, currentTerm, votedFor, role (Follower/Candidate/Leader), log[], commitIndex, lastApplied, leaderId, election timer, heartbeat timer.
1. Implement randomized election timeout 500-800 ms and heartbeat cadence 150 ms; reset election timer on valid heartbeat/append.
1. Implement POST /request-vote with term comparison, one-vote-per-term rule, and vote-grant criteria; higher term forces step-down.
1. Implement POST /heartbeat as a lightweight term/leader liveness path that updates follower term/leader and resets timeout.
1. Implement POST /append-entries for log append attempts with prev-log consistency checks and follower ack payloads including success and follower log index.
1. Implement POST /sync-log for catch-up: leader sends missing entries starting from follower index; follower replaces divergent suffix only for uncommitted tail and updates commit index. Preserve committed-entry immutability.
1. Implement leader-side majority commit tracking (for 3 nodes, commit on self + at least one follower ack) and observability logs for election start, term changes, leadership changes, append acks, and commit events.
1. Phase 3 - Gateway Routing and Client Session Stability.
1. Implement WebSocket gateway server to accept client connections, receive stroke events, and maintain connected client registry.
1. Implement leader routing table and health probing over replica endpoints; on leader failure or rejection, discover new leader by querying replicas and re-route without dropping existing client sockets.
1. Implement stroke forwarding flow: client stroke -> gateway -> leader append request; only broadcast to clients when leader confirms committed entry.
1. Implement backpressure-safe broadcast path and idempotency guard (entry ID) to avoid duplicate client rendering during retries/failover.
1. Phase 4 - Frontend Canvas and Real-Time UX.
1. Build frontend static app with HTML/CSS/JS canvas supporting mouse/touch pointer events and stroke serialization (points, color, width, timestamp, strokeId).
1. Implement optimistic local stroke preview while authoritative commit events from gateway finalize render order; ensure remote/local rendering uses same committed message shape.
1. Add connection-state indicator and automatic WebSocket reconnect; preserve drawing continuity across transient gateway/leader failover.
1. Prevent flicker by batching draw segments per animation frame and avoiding full-canvas clears except initial sync.
1. Phase 5 - Docker Orchestration and Hot Reload Behavior.
1. Create docker-compose with gateway + 3 replicas on shared network, unique REPLICA_ID env vars, peer lists, exposed debug ports, and startup ordering.
1. Configure bind mounts for replica1/, replica2/, replica3/ and dev runner (nodemon) so code changes trigger graceful restart/rejoin without system-wide downtime.
1. Ensure gateway startup tolerates unavailable leader at boot and continues probing until cluster elects one.
1. Phase 6 - Reliability Test Harness and Validation.
1. Add a smoke test script that opens multiple WebSocket clients, sends strokes, and verifies all clients receive identical committed stroke sequence.
1. Add failover script: identify leader, stop leader container, continue sending strokes, verify no client disconnect and eventual continued commits under new leader.
1. Add restart catch-up script: restart a follower with empty log, verify /sync-log catches it up and it resumes normal replication.
1. Capture expected logs/assertions for elections, term increments, leader invalidation, majority commit, and catch-up completion.

**Relevant files**
- /home/tanya/PES1UG23CS638/MiniRAFT/docker-compose.yml - define 5 services, network, ports, env, depends_on, bind mounts, restart behavior.
- /home/tanya/PES1UG23CS638/MiniRAFT/gateway/package.json - runtime/dev scripts and dependencies.
- /home/tanya/PES1UG23CS638/MiniRAFT/gateway/server.js - WebSocket connection management, leader routing, forward-and-broadcast commit flow.
- /home/tanya/PES1UG23CS638/MiniRAFT/gateway/leaderDiscovery.js - active leader probing and failover rerouting.
- /home/tanya/PES1UG23CS638/MiniRAFT/replica1/package.json - replica runtime and dev scripts.
- /home/tanya/PES1UG23CS638/MiniRAFT/replica1/server.js - HTTP API wiring for required RAFT endpoints.
- /home/tanya/PES1UG23CS638/MiniRAFT/replica1/raftNode.js - core RAFT state machine and timers.
- /home/tanya/PES1UG23CS638/MiniRAFT/replica1/rpcClient.js - inter-replica RPC calls and retry behavior.
- /home/tanya/PES1UG23CS638/MiniRAFT/replica2/* - same implementation as replica1 with distinct env identity.
- /home/tanya/PES1UG23CS638/MiniRAFT/replica3/* - same implementation as replica1 with distinct env identity.
- /home/tanya/PES1UG23CS638/MiniRAFT/frontend/index.html - canvas and UI shell.
- /home/tanya/PES1UG23CS638/MiniRAFT/frontend/app.js - drawing input, WebSocket messaging, rendering of committed strokes.
- /home/tanya/PES1UG23CS638/MiniRAFT/frontend/styles.css - responsive canvas layout and status UI.
- /home/tanya/PES1UG23CS638/MiniRAFT/tests/smoke.js - multi-client consistency checks.
- /home/tanya/PES1UG23CS638/MiniRAFT/tests/failover.js - leader failure/no-disconnect verification.
- /home/tanya/PES1UG23CS638/MiniRAFT/tests/restart-sync.js - follower restart catch-up verification.

**Verification**
1. Build and run: docker compose up --build.
2. Confirm election timing via logs: exactly one leader elected, heartbeats emitted every ~150 ms, followers timeout in 500-800 ms range when isolated.
3. Open multiple browser clients, draw concurrently, and verify all canvases converge to identical stroke order.
4. Kill current leader container during active drawing and verify: clients stay connected, gateway reroutes, commits resume after new election.
5. Restart a follower container and verify it rejoins as follower, receives sync via /sync-log, and reaches leader commit index.
6. Run smoke/failover/restart test scripts and assert no dropped committed entries, no duplicate commit broadcasts, and monotonic term handling.
7. Inspect logs for required observability events: elections, term changes, commits, leader step-down on higher term.

**Decisions**
- Stack fixed to Node.js + Express + ws + vanilla JS.
- Log persistence intentionally excluded to remain strict with restart flow in instructions (restart begins with empty log then catches up).
- Scope includes reliability scripts and manual validation guide; does not include optional enhancements (undo/redo, monitoring dashboard, partitions).

**Further Considerations**
1. Message schema versioning recommendation: include type, term, leaderId, entryId, stroke payload, and commitIndex to simplify retries and debugging.
2. Gateway dedup recommendation: maintain short-lived committed-entry cache keyed by entryId to prevent duplicate broadcasts during failover retries.
3. Deterministic test recommendation: use seeded stroke generators so consistency checks are reproducible.