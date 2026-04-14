# Distributed Real-Time Drawing Board with Mini-RAFT
## Implementation Instructions for Copilot

---

## 1. Overview

Build a distributed real-time drawing application with:

- A **WebSocket Gateway**
- A **cluster of 3 replica nodes**
- A **browser-based frontend**
- A **Mini-RAFT consensus protocol**

The system must ensure:
- Real-time synchronization
- Fault tolerance
- Zero-downtime during replica restarts

---

## 2. System Components

### 2.1 Gateway Service

Responsibilities:

- Accept WebSocket connections from clients
- Receive drawing strokes from clients
- Forward strokes to the **current leader replica**
- Broadcast committed strokes to all connected clients
- Detect leader changes and re-route traffic automatically
- Ensure clients are **not disconnected during failover**

---

### 2.2 Replica Nodes (3 Instances)

Each replica must implement the following states:

- `Follower`
- `Candidate`
- `Leader`

Each replica must:

- Maintain an **append-only stroke log**
- Participate in **leader election**
- Replicate logs across nodes
- Commit entries only after **majority acknowledgment**
- Synchronize state after restart

---

### 2.3 Required RPC Endpoints

Each replica must expose:

- `POST /request-vote`
- `POST /append-entries`
- `POST /heartbeat`
- `POST /sync-log`

---

## 3. Mini-RAFT Protocol Requirements

### 3.1 Node States

- **Follower**
  - Waits for heartbeats
- **Candidate**
  - Starts election on timeout
- **Leader**
  - Handles client requests and log replication

---

### 3.2 Leader Election

- Election timeout: **500–800 ms (randomized)**
- Heartbeat interval: **150 ms**

Rules:

- If follower misses heartbeat → becomes candidate
- Candidate:
  - Increments term
  - Sends `RequestVote` RPCs
- Becomes leader if it receives **majority votes (≥2)**
- Split vote → retry election

---

### 3.3 Log Replication

Flow:

1. Client → Gateway → Leader
2. Leader:
   - Append entry to local log
   - Send `AppendEntries` to followers
3. Followers:
   - Append entry
   - Respond with acknowledgment
4. Leader:
   - Marks entry as committed after majority
   - Sends committed stroke to Gateway
5. Gateway:
   - Broadcasts to all clients

---

### 3.4 Safety Rules

- Committed entries must **never be overwritten**
- Higher term always overrides lower term
- Outdated leaders must step down
- Elections must retry on split votes

---

### 3.5 Node Restart / Catch-Up

When a replica restarts:

1. Starts as **Follower with empty log**
2. Receives `AppendEntries`
3. If log mismatch:
   - Respond with current log index
4. Leader calls `/sync-log`
5. Follower:
   - Receives missing entries
   - Updates log and commit index
6. Node rejoins cluster normally

---

## 4. Frontend Requirements

- Canvas-based drawing interface
- Support mouse/touch drawing
- Send strokes in real-time via WebSocket
- Render:
  - Local strokes
  - Remote strokes
- Must handle:
  - No flickering
  - No lag during failover

---

## 5. Functional Requirements

### Gateway

- WebSocket connection management
- Leader routing logic
- Failover handling without disconnects

### Replicas

Must implement:

- Leader election
- Term tracking
- Heartbeats
- RequestVote RPC
- AppendEntries RPC
- Log replication
- Commit mechanism
- Catch-up sync
- Leader invalidation (on higher term)

---

## 6. Non-Functional Requirements

- **Consistency**: All clients see identical canvas state
- **Availability**: System must always respond
- **Fault Tolerance**: Replicas can restart anytime
- **Scalability**: Adding replicas should not break correctness
- **Observability**:
  - Log elections
  - Log term changes
  - Log commits

---

## 7. Docker Requirements

### 7.1 Containers

- 1 Gateway container
- 3 Replica containers

Each replica:

- Must run independently
- Must have a **unique ID (env variable)**

---

### 7.2 Hot Reload

- Use bind-mounted directories:
  - `replica1/`
  - `replica2/`
  - `replica3/`

Behavior:

- Code change → container reload
- Old instance shuts down gracefully
- New instance rejoins cluster
- No system downtime

---

### 7.3 docker-compose.yml

Must include:

- Gateway service
- 3 replica services
- Shared network
- Environment variables for replica IDs
- Proper startup ordering
- Exposed ports (for debugging)

---

## 8. Reliability Requirements

System must handle:

- Leader failure
- Replica restart
- Multiple client connections
- Continuous drawing during failures

Guarantees:

- No data loss
- No client disconnection
- Consistent canvas state after recovery

---

## 9. Deliverable Structure (Code Only)


/gateway
/replica1
/replica2
/replica3
/frontend
docker-compose.yml


Each component must be fully functional and integrated.

---

## 10. Optional Enhancements

- Add more replicas
- Implement undo/redo via log compensation
- Add monitoring dashboard (leader, term, logs)
- Simulate network partitions