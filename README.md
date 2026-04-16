# Distributed Real-Time Drawing Board with Mini-RAFT

A fault-tolerant real-time collaborative drawing system built with a WebSocket gateway, a 4-node Mini-RAFT cluster, and a browser canvas frontend.

## What this project implements

- Real-time drawing synchronization across multiple clients
- 4-replica Mini-RAFT cluster with roles:
  - Follower
  - Candidate
  - Leader
- Leader election with randomized timeout (500-800 ms)
- Heartbeats every 150 ms
- Log replication with majority commit (3 of 4)
- Leader failover without disconnecting connected WebSocket clients
- Follower catch-up via sync-log flow after restart
- Dockerized multi-service setup with bind mounts for hot reload
- Automated smoke, failover, and restart-sync test scripts

## Project structure

- gateway/
- replica1/
- replica2/
- replica3/
- replica4/
- frontend/
- tests/
- docs/
- docker-compose.yml

## Architecture

1. Client sends stroke via WebSocket to gateway.
2. Gateway forwards stroke to current leader.
3. Leader appends stroke to local log and replicates to followers.
4. Followers acknowledge append.
5. Leader commits entry after majority acknowledgment.
6. Leader notifies gateway with committed entry.
7. Gateway broadcasts committed stroke to all clients.

During leader failure:

1. Followers timeout and start election.
2. New leader is elected with majority votes.
3. Gateway discovers new leader and reroutes traffic.
4. Existing client WebSocket connections remain active.

## Replica API endpoints

Each replica exposes:

- POST /request-vote
- POST /append-entries
- POST /heartbeat
- POST /sync-log

Also available for diagnostics and client forwarding:

- GET /status
- POST /client-entry

## Tech stack

- Node.js 20
- Express
- ws (WebSocket)
- Vanilla HTML/CSS/JS canvas frontend
- Docker Compose

## Quick start

### 1. Build and run

From project root:

```bash
docker compose up --build
```

### 2. Open app

- Frontend: http://localhost:3000
- Gateway health: http://localhost:8080/health

### 3. Check replica status

```bash
curl http://localhost:9001/status
curl http://localhost:9002/status
curl http://localhost:9003/status
curl http://localhost:9004/status
```

## Automated tests

From project root:

```bash
cd tests
npm install
```

Run tests:

```bash
npm run smoke
npm run failover
npm run restart-sync
```

### Test meanings

- smoke: multi-client consistency and commit-order convergence
- failover: automatically kills active leader container, validates continued commits, then restarts killed replica
- restart-sync: automatically kills one follower, sends writes during downtime, restarts it, then verifies catch-up convergence

## Manual verification checklist

- Drawing in one browser tab appears in others in near real time
- No client disconnect during leader kill
- New leader appears after failover
- Restarted replica rejoins as follower and catches up
- Logs show election events, term transitions, and commit events

## Useful commands

Stop services:

```bash
docker compose down
```

List services:

```bash
docker compose ps
```

Capture logs:

```bash
docker compose logs --timestamps > submission-cluster.log
```

## Notes on consistency and safety

- Committed entries are never overwritten
- Higher term forces outdated leader to step down
- Split-vote elections retry automatically
- Gateway broadcasts only committed entries to clients

## Troubleshooting

- If no leader is elected, inspect replica logs for repeated split votes
- If drawing pauses after failover, wait for election window (typically a few seconds)
- If a restarted follower lags, verify sync-log requests are reaching that replica
- If tests fail due to Docker permissions, run with a user that can execute docker compose commands

## Additional docs

- Detailed run and verification flow: docs/run-instructions.md
