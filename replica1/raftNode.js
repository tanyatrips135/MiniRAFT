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

  logEvent(event, details = {}) {
    void details;
    console.log(`${event} role=${this.role}`);
  }

  transitionRole(nextRole, reason, details = {}) {
    if (this.role === nextRole) {
      return;
    }

    const from = this.role;
    this.role = nextRole;
    this.logEvent("role-transition", { from, to: nextRole, reason, ...details });
  }

  start() {
    this.logEvent("node-started", {
      electionMinMs: this.electionMinMs,
      electionMaxMs: this.electionMaxMs,
      heartbeatMs: this.heartbeatMs,
      peers: this.peers.map((peer) => peer.id)
    });
    this.resetElectionTimer("startup", true);
  }

  stop() {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.logEvent("node-stopped");
  }

  getRandomElectionTimeout() {
    const span = this.electionMaxMs - this.electionMinMs;
    return this.electionMinMs + Math.floor(Math.random() * (span + 1));
  }

  resetElectionTimer(reason = "refresh", emitLog = true) {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    const timeoutMs = this.getRandomElectionTimeout();
    this.electionTimer = setTimeout(() => {
      if (this.role !== "Leader") {
        this.logEvent("election-timeout", { timeoutMs });
        this.startElection().catch(() => {});
      }
    }, timeoutMs);

    if (emitLog) {
      this.logEvent("election-timer-reset", { reason, timeoutMs });
    }
  }

  becomeFollower(term, leaderId = null, leaderUrl = null, options = {}) {
    const { source = "rpc", suppressTimerLog = false } = options;
    const previousLeaderId = this.leaderId;
    const previousLeaderUrl = this.leaderUrl;

    if (term > this.currentTerm) {
      this.logEvent("term-updated", { from: this.currentTerm, to: term, source });
      this.currentTerm = term;
      this.votedFor = null;
    }

    this.transitionRole("Follower", source, { leaderId, leaderUrl });
    this.leaderId = leaderId;
    this.leaderUrl = leaderUrl;

    if (previousLeaderId !== this.leaderId || previousLeaderUrl !== this.leaderUrl) {
      this.logEvent("leader-pointer-updated", {
        fromLeaderId: previousLeaderId,
        toLeaderId: this.leaderId,
        fromLeaderUrl: previousLeaderUrl,
        toLeaderUrl: this.leaderUrl,
        source
      });
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.resetElectionTimer(`follower-${source}`, !suppressTimerLog);
  }

  async startElection() {
    this.transitionRole("Candidate", "election-timeout");
    this.currentTerm += 1;
    this.votedFor = this.nodeId;
    this.leaderId = null;
    this.leaderUrl = null;

    const electionTerm = this.currentTerm;
    const lastLogIndex = this.log.length - 1;
    const lastLogTerm = lastLogIndex >= 0 ? this.log[lastLogIndex].term : 0;
    this.logEvent("election-started", {
      electionTerm,
      lastLogIndex,
      lastLogTerm,
      selfVote: this.nodeId
    });

    this.resetElectionTimer("election-in-progress", true);

    let votes = 1;

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
      ).then((result) => ({ peer, result }));
    });

    const results = await Promise.all(requests);

    for (const item of results) {
      if (!item || !item.result || !item.result.data) {
        continue;
      }

      const { peer, result } = item;

      const responseTerm = Number(result.data.term || 0);
      if (responseTerm > this.currentTerm) {
        this.logEvent("election-aborted-higher-term", {
          peerId: peer.id,
          responseTerm,
          electionTerm
        });
        this.becomeFollower(responseTerm, result.data.leaderId || null, result.data.leaderUrl || null, {
          source: "request-vote-response"
        });
        return;
      }

      if (result.ok && result.data.voteGranted === true) {
        votes += 1;
        this.logEvent("vote-granted", { peerId: peer.id, votes });
      } else {
        this.logEvent("vote-denied", {
          peerId: peer.id,
          status: result.status,
          responseTerm
        });
      }
    }

    if (this.role !== "Candidate" || this.currentTerm !== electionTerm) {
      this.logEvent("election-ignored-stale", {
        electionTerm,
        currentRole: this.role,
        currentTerm: this.currentTerm
      });
      return;
    }

    this.logEvent("election-result", {
      electionTerm,
      votes,
      required: this.majority()
    });

    if (votes >= this.majority()) {
      this.becomeLeader();
      return;
    }

    this.logEvent("split-vote", { electionTerm, votes, required: this.majority() });
  }

  becomeLeader() {
    this.transitionRole("Leader", "majority-vote");
    this.leaderId = this.nodeId;
    this.leaderUrl = this.selfUrl;

    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.logEvent("leader-ready", {
      heartbeatMs: this.heartbeatMs,
      peerCount: this.peers.length
    });

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

    this.logEvent("request-vote-received", {
      fromCandidate: candidateId,
      requestTerm: term,
      lastLogIndex,
      lastLogTerm
    });

    if (term < this.currentTerm) {
      this.logEvent("request-vote-rejected", {
        fromCandidate: candidateId,
        reason: "stale-term",
        requestTerm: term
      });
      return {
        term: this.currentTerm,
        voteGranted: false,
        leaderId: this.leaderId,
        leaderUrl: this.leaderUrl
      };
    }

    if (term > this.currentTerm) {
      this.becomeFollower(term, null, null, { source: "request-vote" });
    }

    let voteGranted = false;
    const neverVotedOrSame = this.votedFor === null || this.votedFor === candidateId;
    const upToDate = this.isLogUpToDate(lastLogIndex, lastLogTerm);
    if (neverVotedOrSame && upToDate) {
      this.votedFor = candidateId;
      voteGranted = true;
      this.leaderId = candidateId;
      this.leaderUrl = candidateUrl;
      this.resetElectionTimer("vote-granted", true);
      this.logEvent("vote-recorded", {
        votedFor: candidateId,
        requestTerm: term
      });
    } else {
      this.logEvent("request-vote-rejected", {
        fromCandidate: candidateId,
        reason: neverVotedOrSame ? "log-not-up-to-date" : "already-voted",
        votedFor: this.votedFor,
        candidateLastLogIndex: lastLogIndex,
        candidateLastLogTerm: lastLogTerm
      });
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

    this.becomeFollower(term, leaderId, leaderUrl, {
      source: "heartbeat",
      suppressTimerLog: true
    });
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

    this.logEvent("append-entries-received", {
      fromLeaderId: leaderId,
      requestTerm: term,
      prevLogIndex,
      prevLogTerm,
      entriesCount: entries.length,
      leaderCommit
    });

    if (term < this.currentTerm) {
      this.logEvent("append-entries-rejected", {
        reason: "stale-term",
        requestTerm: term
      });
      return {
        success: false,
        term: this.currentTerm,
        currentIndex: this.log.length - 1,
        leaderId: this.leaderId,
        leaderUrl: this.leaderUrl
      };
    }

    this.becomeFollower(term, leaderId, leaderUrl, {
      source: "append-entries",
      suppressTimerLog: true
    });

    if (prevLogIndex >= 0) {
      const prev = this.log[prevLogIndex];
      if (!prev || prev.term !== prevLogTerm) {
        this.logEvent("append-entries-rejected", {
          reason: "prev-log-mismatch",
          prevLogIndex,
          prevLogTerm,
          localPrevTerm: prev ? prev.term : null
        });
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
    let appendedCount = 0;
    let replacedCount = 0;

    for (const incoming of entries) {
      const existing = this.log[writeIndex];
      if (!existing) {
        this.log.push({ ...incoming });
        appendedCount += 1;
      } else if (existing.term !== incoming.term || existing.entryId !== incoming.entryId) {
        if (writeIndex <= this.commitIndex) {
          this.logEvent("append-entries-rejected", {
            reason: "committed-conflict",
            writeIndex,
            commitIndex: this.commitIndex
          });
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
        replacedCount += 1;
      }
      writeIndex += 1;
    }

    if (leaderCommit > this.commitIndex) {
      const previousCommit = this.commitIndex;
      this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
      for (let i = 0; i <= this.commitIndex; i += 1) {
        if (this.log[i]) this.log[i].committed = true;
      }
      this.lastApplied = this.commitIndex;
      this.logEvent("commit-index-advanced", {
        source: "append-entries",
        from: previousCommit,
        to: this.commitIndex
      });
    }

    if (entries.length > 0) {
      this.logEvent("append-entries-applied", {
        appendedCount,
        replacedCount,
        newTailIndex: this.log.length - 1
      });
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

    this.logEvent("sync-log-received", {
      fromLeaderId: leaderId,
      requestTerm: term,
      fromIndex,
      entriesCount: entries.length,
      leaderCommit
    });

    if (term < this.currentTerm) {
      this.logEvent("sync-log-rejected", {
        reason: "stale-term",
        requestTerm: term
      });
      return { success: false, term: this.currentTerm, currentIndex: this.log.length - 1 };
    }

    this.becomeFollower(term, leaderId, leaderUrl, {
      source: "sync-log",
      suppressTimerLog: true
    });

    if (fromIndex <= this.commitIndex) {
      this.logEvent("sync-log-rejected", {
        reason: "cannot-rewrite-committed",
        fromIndex,
        commitIndex: this.commitIndex
      });
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

    this.logEvent("sync-log-applied", {
      fromIndex,
      rewrittenEntries: entries.length,
      newTailIndex: this.log.length - 1
    });

    if (leaderCommit > this.commitIndex) {
      const previousCommit = this.commitIndex;
      this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
      for (let i = 0; i <= this.commitIndex; i += 1) {
        if (this.log[i]) this.log[i].committed = true;
      }
      this.lastApplied = this.commitIndex;
      this.logEvent("commit-index-advanced", {
        source: "sync-log",
        from: previousCommit,
        to: this.commitIndex
      });
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
      ).then((result) => ({ peer, result }));
    });

    const results = await Promise.all(requests);

    for (const item of results) {
      const peer = item.peer;
      const result = item.result;
      const term = Number(result.data?.term || 0);
      if (term > this.currentTerm) {
        this.becomeFollower(term, result.data?.leaderId || null, result.data?.leaderUrl || null, {
          source: "heartbeat-response"
        });
        return;
      }
    }
  }

  async replicateEntry(entry) {
    if (this.role !== "Leader") {
      this.logEvent("client-entry-rejected", {
        reason: "not-leader",
        entryId: entry.entryId
      });
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
    this.logEvent("entry-appended-local", {
      entryId: localEntry.entryId,
      index,
      prevLogIndex,
      prevLogTerm
    });

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
            this.logEvent("replication-aborted-higher-term", {
              peerId: peer.id,
              responseTerm: term,
              entryId: localEntry.entryId
            });
            this.becomeFollower(term, result.data?.leaderId || null, result.data?.leaderUrl || null, {
              source: "append-entries-response"
            });
            return false;
          }

          if (result.ok && result.data?.success) {
            this.logEvent("append-entries-ack", {
              peerId: peer.id,
              entryId: localEntry.entryId,
              followerIndex: result.data?.currentIndex
            });
            return true;
          }

          const followerIndex = Number(result.data?.currentIndex ?? -1);
          const fromIndex = Math.max(0, Math.min(followerIndex, this.log.length));
          this.logEvent("append-entries-retry-sync", {
            peerId: peer.id,
            entryId: localEntry.entryId,
            followerIndex,
            fromIndex
          });
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
            this.logEvent("sync-log-aborted-higher-term", {
              peerId: peer.id,
              responseTerm: syncTerm,
              entryId: localEntry.entryId
            });
            this.becomeFollower(syncTerm, syncResult.data?.leaderId || null, syncResult.data?.leaderUrl || null, {
              source: "sync-log-response"
            });
            return false;
          }

          const syncOk = syncResult.ok && syncResult.data?.success;
          this.logEvent(syncOk ? "sync-log-ack" : "sync-log-failed", {
            peerId: peer.id,
            entryId: localEntry.entryId,
            status: syncResult.status,
            reason: syncResult.data?.reason || null
          });
          return syncOk;
        })
      )
    );

    for (const ok of replication) {
      if (ok) ackCount += 1;
    }

    if (this.role !== "Leader") {
      this.logEvent("entry-replication-cancelled", {
        entryId: localEntry.entryId,
        reason: "stepped-down"
      });
      return { success: false, error: "stepped-down" };
    }

    if (ackCount >= this.majority()) {
      this.commitIndex = index;
      this.lastApplied = index;
      this.log[index].committed = true;
      this.logEvent("entry-committed", {
        entryId: localEntry.entryId,
        index,
        ackCount,
        required: this.majority()
      });
      await this.sendCommittedEntryToGateway(this.log[index]);
      return { success: true, committed: true, entry: this.log[index] };
    }

    this.logEvent("entry-commit-failed", {
      entryId: localEntry.entryId,
      index,
      ackCount,
      required: this.majority()
    });
    return { success: false, committed: false, error: "no-majority" };
  }

  async sendCommittedEntryToGateway(entry) {
    if (!this.gatewayUrl) return;
    const response = await postJson(`${this.gatewayUrl}/committed`, { entry }, 900);
    if (response.ok) {
      this.logEvent("gateway-commit-notified", {
        entryId: entry.entryId,
        status: response.status
      });
      return;
    }

    this.logEvent("gateway-commit-notify-failed", {
      entryId: entry.entryId,
      status: response.status,
      error: response.data?.error || null
    });
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
