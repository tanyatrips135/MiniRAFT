const { postJson } = require("./rpcClient");

class RaftNode {
  constructor(config) {
    this.nodeId = config.nodeId;
    this.port = config.port;
    this.selfUrl = config.selfUrl;
    this.gatewayUrl = config.gatewayUrl;
    this.peers = config.peers;
    this.electionMinMs = config.electionMinMs;
    this.electionMaxMs = config.electionMaxMs;
    this.heartbeatMs = config.heartbeatMs;

    this.role = "Follower";
    this.currentTerm = 0;
    this.votedFor = null;
    this.leaderId = null;
    this.leaderUrl = null;

    this.log = [];
    this.commitIndex = -1;
    this.lastApplied = -1;

    this.electionTimer = null;
    this.heartbeatTimer = null;
  }

  start() {
    this.resetElectionTimer();
  }

  stop() {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  getRandomElectionTimeout() {
    const span = this.electionMaxMs - this.electionMinMs;
    return this.electionMinMs + Math.floor(Math.random() * (span + 1));
  }

  resetElectionTimer() {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    this.electionTimer = setTimeout(() => {
      if (this.role !== "Leader") {
        this.startElection().catch(() => {});
      }
    }, this.getRandomElectionTimeout());
  }

  becomeFollower(term, leaderId = null, leaderUrl = null) {
    if (term > this.currentTerm) {
      console.log(`[${this.nodeId}] term update ${this.currentTerm} -> ${term}`);
      this.currentTerm = term;
      this.votedFor = null;
    }

    if (this.role !== "Follower") {
      console.log(`[${this.nodeId}] stepping down to follower`);
    }

    this.role = "Follower";
    this.leaderId = leaderId;
    this.leaderUrl = leaderUrl;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.resetElectionTimer();
  }

  async startElection() {
    this.role = "Candidate";
    this.currentTerm += 1;
    this.votedFor = this.nodeId;
    this.leaderId = null;
    this.leaderUrl = null;

    const electionTerm = this.currentTerm;
    console.log(`[${this.nodeId}] election started for term ${electionTerm}`);

    this.resetElectionTimer();

    let votes = 1;
    const lastLogIndex = this.log.length - 1;
    const lastLogTerm = lastLogIndex >= 0 ? this.log[lastLogIndex].term : 0;

    const requests = this.peers.map((peer) => {
      return postJson(
        `${peer.url}/request-vote`,
        {
          term: electionTerm,
          candidateId: this.nodeId,
          candidateUrl: this.selfUrl,
          lastLogIndex,
          lastLogTerm
        },
        550
      );
    });

    const results = await Promise.all(requests);

    for (const result of results) {
      if (!result.data) continue;

      const responseTerm = Number(result.data.term || 0);
      if (responseTerm > this.currentTerm) {
        this.becomeFollower(responseTerm, result.data.leaderId || null, result.data.leaderUrl || null);
        return;
      }

      if (result.ok && result.data.voteGranted === true) {
        votes += 1;
      }
    }

    if (this.role !== "Candidate" || this.currentTerm !== electionTerm) {
      return;
    }

    if (votes >= this.majority()) {
      this.becomeLeader();
      return;
    }

    console.log(`[${this.nodeId}] split vote in term ${electionTerm}, retrying`);
  }

  becomeLeader() {
    this.role = "Leader";
    this.leaderId = this.nodeId;
    this.leaderUrl = this.selfUrl;

    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    console.log(`[${this.nodeId}] became leader for term ${this.currentTerm}`);

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats().catch(() => {});
    }, this.heartbeatMs);

    this.sendHeartbeats().catch(() => {});
  }

  majority() {
    return Math.floor((this.peers.length + 1) / 2) + 1;
  }

  isLogUpToDate(lastLogIndex, lastLogTerm) {
    const myLastIndex = this.log.length - 1;
    const myLastTerm = myLastIndex >= 0 ? this.log[myLastIndex].term : 0;

    if (lastLogTerm !== myLastTerm) {
      return lastLogTerm > myLastTerm;
    }

    return lastLogIndex >= myLastIndex;
  }

  handleRequestVote(body) {
    const term = Number(body.term || 0);
    const candidateId = body.candidateId;
    const candidateUrl = body.candidateUrl || null;
    const lastLogIndex = Number(body.lastLogIndex || -1);
    const lastLogTerm = Number(body.lastLogTerm || 0);

    if (term < this.currentTerm) {
      return {
        term: this.currentTerm,
        voteGranted: false,
        leaderId: this.leaderId,
        leaderUrl: this.leaderUrl
      };
    }

    if (term > this.currentTerm) {
      this.becomeFollower(term, null, null);
    }

    let voteGranted = false;
    const neverVotedOrSame = this.votedFor === null || this.votedFor === candidateId;
    if (neverVotedOrSame && this.isLogUpToDate(lastLogIndex, lastLogTerm)) {
      this.votedFor = candidateId;
      voteGranted = true;
      this.leaderId = candidateId;
      this.leaderUrl = candidateUrl;
      this.resetElectionTimer();
      console.log(`[${this.nodeId}] voted for ${candidateId} in term ${this.currentTerm}`);
    }

    return {
      term: this.currentTerm,
      voteGranted,
      leaderId: this.leaderId,
      leaderUrl: this.leaderUrl
    };
  }

  handleHeartbeat(body) {
    const term = Number(body.term || 0);
    const leaderId = body.leaderId || null;
    const leaderUrl = body.leaderUrl || null;

    if (term < this.currentTerm) {
      return {
        success: false,
        term: this.currentTerm,
        leaderId: this.leaderId,
        leaderUrl: this.leaderUrl
      };
    }

    this.becomeFollower(term, leaderId, leaderUrl);
    return {
      success: true,
      term: this.currentTerm,
      leaderId: this.leaderId,
      leaderUrl: this.leaderUrl
    };
  }

  handleAppendEntries(body) {
    const term = Number(body.term || 0);
    const leaderId = body.leaderId || null;
    const leaderUrl = body.leaderUrl || null;
    const prevLogIndex = Number(body.prevLogIndex ?? -1);
    const prevLogTerm = Number(body.prevLogTerm ?? 0);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const leaderCommit = Number(body.leaderCommit ?? -1);

    if (term < this.currentTerm) {
      return {
        success: false,
        term: this.currentTerm,
        currentIndex: this.log.length - 1,
        leaderId: this.leaderId,
        leaderUrl: this.leaderUrl
      };
    }

    this.becomeFollower(term, leaderId, leaderUrl);

    if (prevLogIndex >= 0) {
      const prev = this.log[prevLogIndex];
      if (!prev || prev.term !== prevLogTerm) {
        return {
          success: false,
          term: this.currentTerm,
          currentIndex: this.log.length - 1,
          leaderId: this.leaderId,
          leaderUrl: this.leaderUrl
        };
      }
    }

    let writeIndex = prevLogIndex + 1;

    for (const incoming of entries) {
      const existing = this.log[writeIndex];
      if (!existing) {
        this.log.push({ ...incoming });
      } else if (existing.term !== incoming.term || existing.entryId !== incoming.entryId) {
        if (writeIndex <= this.commitIndex) {
          return {
            success: false,
            term: this.currentTerm,
            currentIndex: this.log.length - 1,
            leaderId: this.leaderId,
            leaderUrl: this.leaderUrl,
            reason: "committed-conflict"
          };
        }
        this.log = this.log.slice(0, writeIndex);
        this.log.push({ ...incoming });
      }
      writeIndex += 1;
    }

    if (leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
      for (let i = 0; i <= this.commitIndex; i += 1) {
        if (this.log[i]) this.log[i].committed = true;
      }
      this.lastApplied = this.commitIndex;
    }

    return {
      success: true,
      term: this.currentTerm,
      currentIndex: this.log.length - 1,
      leaderId: this.leaderId,
      leaderUrl: this.leaderUrl
    };
  }

  handleSyncLog(body) {
    const term = Number(body.term || 0);
    const leaderId = body.leaderId || null;
    const leaderUrl = body.leaderUrl || null;
    const fromIndex = Number(body.fromIndex || 0);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const leaderCommit = Number(body.leaderCommit ?? -1);

    if (term < this.currentTerm) {
      return { success: false, term: this.currentTerm, currentIndex: this.log.length - 1 };
    }

    this.becomeFollower(term, leaderId, leaderUrl);

    if (fromIndex <= this.commitIndex) {
      return {
        success: false,
        term: this.currentTerm,
        currentIndex: this.log.length - 1,
        reason: "cannot-rewrite-committed"
      };
    }

    this.log = this.log.slice(0, fromIndex);
    for (const entry of entries) {
      this.log.push({ ...entry });
    }

    if (leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
      for (let i = 0; i <= this.commitIndex; i += 1) {
        if (this.log[i]) this.log[i].committed = true;
      }
      this.lastApplied = this.commitIndex;
    }

    return {
      success: true,
      term: this.currentTerm,
      currentIndex: this.log.length - 1
    };
  }

  async sendHeartbeats() {
    if (this.role !== "Leader") return;

    const requests = this.peers.map((peer) => {
      return postJson(
        `${peer.url}/heartbeat`,
        {
          term: this.currentTerm,
          leaderId: this.nodeId,
          leaderUrl: this.selfUrl
        },
        420
      );
    });

    const results = await Promise.all(requests);
    for (const result of results) {
      const term = Number(result.data?.term || 0);
      if (term > this.currentTerm) {
        this.becomeFollower(term, result.data?.leaderId || null, result.data?.leaderUrl || null);
        return;
      }
    }
  }

  async replicateEntry(entry) {
    if (this.role !== "Leader") {
      return { success: false, error: "not-leader" };
    }

    const index = this.log.length;
    const prevLogIndex = index - 1;
    const prevLogTerm = prevLogIndex >= 0 ? this.log[prevLogIndex].term : 0;

    const localEntry = {
      index,
      term: this.currentTerm,
      entryId: entry.entryId,
      stroke: entry.stroke,
      committed: false,
      createdAt: Date.now()
    };

    this.log.push(localEntry);

    let ackCount = 1;

    const replication = await Promise.all(
      this.peers.map((peer) =>
        postJson(
          `${peer.url}/append-entries`,
          {
            term: this.currentTerm,
            leaderId: this.nodeId,
            leaderUrl: this.selfUrl,
            prevLogIndex,
            prevLogTerm,
            entries: [localEntry],
            leaderCommit: this.commitIndex
          },
          650
        ).then(async (result) => {
          const term = Number(result.data?.term || 0);
          if (term > this.currentTerm) {
            this.becomeFollower(term, result.data?.leaderId || null, result.data?.leaderUrl || null);
            return false;
          }

          if (result.ok && result.data?.success) {
            return true;
          }

          const followerIndex = Number(result.data?.currentIndex ?? -1);
          const fromIndex = Math.max(followerIndex + 1, 0);
          const syncResult = await postJson(
            `${peer.url}/sync-log`,
            {
              term: this.currentTerm,
              leaderId: this.nodeId,
              leaderUrl: this.selfUrl,
              fromIndex,
              entries: this.log.slice(fromIndex),
              leaderCommit: this.commitIndex
            },
            800
          );

          const syncTerm = Number(syncResult.data?.term || 0);
          if (syncTerm > this.currentTerm) {
            this.becomeFollower(syncTerm, syncResult.data?.leaderId || null, syncResult.data?.leaderUrl || null);
            return false;
          }

          return syncResult.ok && syncResult.data?.success;
        })
      )
    );

    for (const ok of replication) {
      if (ok) ackCount += 1;
    }

    if (this.role !== "Leader") {
      return { success: false, error: "stepped-down" };
    }

    if (ackCount >= this.majority()) {
      this.commitIndex = index;
      this.lastApplied = index;
      this.log[index].committed = true;
      console.log(`[${this.nodeId}] committed index ${index} term ${this.currentTerm}`);
      await this.sendCommittedEntryToGateway(this.log[index]);
      return { success: true, committed: true, entry: this.log[index] };
    }

    console.log(`[${this.nodeId}] failed to commit index ${index}; acks=${ackCount}`);
    return { success: false, committed: false, error: "no-majority" };
  }

  async sendCommittedEntryToGateway(entry) {
    if (!this.gatewayUrl) return;
    await postJson(`${this.gatewayUrl}/committed`, { entry }, 900);
  }

  status() {
    return {
      nodeId: this.nodeId,
      role: this.role,
      term: this.currentTerm,
      leaderId: this.leaderId,
      leaderUrl: this.leaderUrl,
      selfUrl: this.selfUrl,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      logLength: this.log.length
    };
  }
}

module.exports = {
  RaftNode
};
