
## Manual Run and Test Guide

## 1. Start from a clean state

Open a terminal in the project root and run:

```bash
docker compose down
docker compose up --build
```

Keep this terminal open to watch live logs.

## 2. Verify all services are up

In a second terminal, run:

```bash
docker compose ps
```

Confirm these containers are running:

- gateway
- replica1
- replica2
- replica3
- frontend

Run quick health checks:

```bash
curl http://localhost:8080/health
curl http://localhost:9001/status
curl http://localhost:9002/status
curl http://localhost:9003/status
curl http://localhost:3000/health
```

## 3. UI real-time sync test (multiple tabs)

1. Open 3 browser tabs at http://localhost:3000.
2. Draw in Tab A continuously for 10 to 20 seconds.
3. Confirm strokes appear in Tab B and Tab C in near real time.
4. Repeat by drawing in Tab B and Tab C as well.

Expected result:

- All tabs converge to the same board state.
- No obvious flicker.
- No disconnect banner.

## 4. Concurrent drawing stress check

1. Draw at the same time in all 3 tabs for 20 to 30 seconds.
2. Watch gateway logs for unexpected errors during this test.

Expected result:

- No crashes.
- No UI freeze.
- No gateway disconnect loop.

## 5. Manual failover test (leader kill while drawing)

Determine the current leader:

```bash
curl http://localhost:9001/status
curl http://localhost:9002/status
curl http://localhost:9003/status
```

1. Identify which node shows role = Leader.
2. Keep drawing in at least one tab.
3. Kill the leader container:

```bash
docker compose kill replica1
```

Use replica2 or replica3 instead, based on whichever is leader.

4. Keep drawing during and after the kill.
5. Wait 2 to 6 seconds for election.
6. Re-check status endpoints and confirm a new leader exists.

Expected result:

- Browser tabs stay connected.
- Drawing resumes after a brief pause.
- New commits continue.

Restart the killed replica:

```bash
docker compose start replica1
```

Use replica2 or replica3 if that was the one killed.

Verify rejoin:

- Status endpoint shows follower role.
- Commit index catches up.

## 6. Automated tests

In a tests terminal, run:

```bash
cd tests
npm install
```

Then run:

```bash
npm run smoke
npm run failover
npm run restart-sync
```

Expected result:

- All tests pass without unhandled errors.

## 7. Log capture for submission evidence

Capture full session logs with timestamps:

```bash
docker compose logs --timestamps > submission-cluster.log
```

Or stream and save while testing:

```bash
docker compose logs -f --timestamps | tee submission-live.log
```

Recommended screenshots:

- Leader before kill
- Leader after kill
- Clients still drawing
- Restarted follower rejoined

## 8. Healthy log signals

- Election events when leader is killed
- Term changes only when needed
- New leader announcement after failover
- Commit events continue after re-election
- Sync or catch-up activity after follower restart
- No repeated error storms
- No unhandled promise errors
- No continuous split-vote loop

## 9. Red flags (unexpected behavior)

- Frequent leader flapping without failures
- Continuous gateway backpressure responses
- Client disconnections during failover
- Commit index divergence that does not recover
- Duplicate committed entries or missing strokes across tabs

## 10. Final acceptance checklist

- Real-time shared drawing works across multiple tabs
- Leader failover occurs with no client disconnect
- Restarted replica rejoins and catches up
- Docker logs show expected elections, term updates, commits, and no persistent error patterns
- Smoke, failover, and restart-sync tests pass