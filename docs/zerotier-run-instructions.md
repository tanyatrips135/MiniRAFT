# MiniRAFT Access Guide Using ZeroTier

This guide explains how to let multiple remote users open the frontend while all backend services and replicas stay on one host machine.

## 1. Target setup

- One host machine runs all containers:
  - frontend
  - gateway
  - replica1
  - replica2
  - replica3
- Multiple client machines join the same ZeroTier network.
- Clients access only the frontend URL on the host.
- Replica ports remain private to reduce risk.

## 2. Prerequisites (ZeroTier account and client setup)

Complete these steps once before joining machines.

### 2.1 Create a ZeroTier account

1. Open https://my.zerotier.com in a browser.
2. Choose Sign Up and create an account.
3. Verify your email if prompted.
4. Sign in to ZeroTier Central.

### 2.2 Create a ZeroTier network in ZeroTier Central

1. In ZeroTier Central, click Create A Network.
2. Open the newly created network.
3. Copy the Network ID (you will use this in the join command).
4. Optional but recommended settings:
  - Give the network a clear name (for example mini-raft-team).
  - Keep Access Control as private.
  - Keep Auto-Assign from managed routes enabled unless you have custom routing needs.

### 2.3 Install ZeroTier One client on each machine

Install on:

- the host machine running Docker containers
- every remote user machine that will open the frontend

Windows:

1. Download installer from https://www.zerotier.com/download/
2. Run installer as Administrator.
3. Open ZeroTier One from Start menu.
4. Confirm service is running.

Ubuntu/Debian (recommended script):

```bash
curl -s https://install.zerotier.com | sudo bash
sudo systemctl enable zerotier-one
sudo systemctl start zerotier-one
```

Ubuntu/Debian (package method, if preferred):

```bash
sudo apt-get update
sudo apt-get install -y zerotier-one
sudo systemctl enable zerotier-one
sudo systemctl start zerotier-one
```

macOS:

1. Download the macOS package from https://www.zerotier.com/download/
2. Install and allow network extension prompts.
3. Open ZeroTier One and confirm it is active.

### 2.4 Verify ZeroTier client installation

On each machine, run:

```bash
zerotier-cli -v
zerotier-cli info
```

Expected:

- version command prints installed version
- info command shows node address and online status

Also ensure Docker and Docker Compose are installed on the host machine.

## 3. Join the ZeroTier network

Run on each machine:

```bash
zerotier-cli join <NETWORK_ID>
```

Then in ZeroTier Central:

- Authorize each machine.
- Confirm each gets a managed IP (for example 10.147.x.y).

Verify on each machine:

```bash
zerotier-cli listnetworks
```

Expected: network status is `OK`.

## 4. Host machine: run MiniRAFT

From project root:

```bash
docker compose up --build
```

Keep the terminal open for logs.

In another terminal, verify services:

```bash
docker compose ps
curl http://localhost:3000/health
curl http://localhost:8080/health
```

## 5. Firewall rules on host

Allow inbound traffic on the ZeroTier interface for:

- TCP 3000 (frontend)
- TCP 8080 (gateway websocket/api path used by frontend)

Do not expose replica ports (9001 to 9003) to remote users.

## 6. Client access URL

On any client machine in the same ZeroTier network, open:

```text
http://<HOST_ZEROTIER_IP>:3000
```

Example:

```text
http://10.147.17.24:3000
```

Because frontend code computes websocket endpoint from browser hostname, it will connect to:

```text
ws://<HOST_ZEROTIER_IP>:8080
```

No frontend code change is required for this.

## 7. Multi-user validation checklist

From 2 to 5 remote client machines:

1. Open the frontend URL.
2. Draw from one client and verify near real-time rendering on others.
3. Draw concurrently from multiple clients.
4. Confirm no disconnect storm in UI.
5. Confirm gateway and replicas stay healthy.

Host-side checks:

```bash
curl http://localhost:9001/status
curl http://localhost:9002/status
curl http://localhost:9003/status
```

Expected:

- exactly one leader
- others followers
- commit index progresses during drawing

## 8. Optional hardening (recommended)

Current compose file publishes replica ports to host. For tighter security, remove `ports` from:

- replica1
- replica2
- replica3

Keep published ports only for:

- frontend: 3000
- gateway: 8080

This keeps replica RPC endpoints internal to Docker network.

## 9. Failover test with remote clients connected

1. Find leader from status endpoints.
2. Keep clients drawing.
3. Kill leader container on host:

```bash
docker compose kill replica1
```

Use actual leader container name.

4. Wait a few seconds for election.
5. Verify clients continue after short pause.
6. Restart killed replica:

```bash
docker compose start replica1
```

7. Confirm restarted node rejoins as follower and catches up.

## 10. Troubleshooting

If client cannot open frontend:

- confirm client and host are in same ZeroTier network
- confirm host is authorized in ZeroTier Central
- confirm host firewall allows ZeroTier interface on TCP 3000 and 8080
- test from client:

```bash
curl http://<HOST_ZEROTIER_IP>:3000/health
curl http://<HOST_ZEROTIER_IP>:8080/health
```

If frontend opens but drawing does not sync:

- check browser console for websocket connection errors to port 8080
- verify gateway container is running
- verify one replica is leader

If leader flaps repeatedly:

- inspect replica logs:

```bash
docker compose logs -f replica1 replica2 replica3
```

## 11. When ZeroTier is not required

You can skip ZeroTier if all users are on the same LAN and can reach host LAN IP directly.

Use:

```text
http://<HOST_LAN_IP>:3000
```

ZeroTier is preferred for users across different networks because setup is simpler and safer than public port exposure.
