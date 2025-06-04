import { EventEmitter } from "events";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import {
  NodeInfo,
  LogEntry,
  Command,
  VoteRequest,
  VoteResponse,
  AppendEntriesRequest,
  AppendEntriesResponse,
  NodeState,
  Snapshot,
} from "./types";
import { PersistentStorage } from "./persistentStorage";

export class RaftNode extends EventEmitter {
  private currentTerm: number = 0;
  private votedFor: string | null = null;
  private logEntries: LogEntry[] = [];
  private commitIndex: number = -1;
  private lastApplied: number = -1;
  private state: NodeState = NodeState.FOLLOWER;
  private leaderId: string | null = null;
  private electionTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private nextIndex: Map<string, number> = new Map();
  private matchIndex: Map<string, number> = new Map();
  private keyValueStore: Map<string, string> = new Map();
  private votes: Set<string> = new Set();
  private commandResults: Map<number, any> = new Map();
  private persistentStorage: PersistentStorage;
  private lastSnapshotIndex: number = -1;
  private lastSnapshotTerm: number = 0;

  private static readonly HEARTBEAT_INTERVAL = 100; // 100ms
  private static readonly MIN_ELECTION_TIMEOUT = 300; // 300ms
  private static readonly MAX_ELECTION_TIMEOUT = 500; // 500ms
  private static readonly VOTE_REQUEST_TIMEOUT = 100; // 100ms
  private static readonly SNAPSHOT_THRESHOLD = 100; // Compact logs after 100 entries

  constructor(private nodeInfo: NodeInfo, private clusterNodes: NodeInfo[]) {
    super();
    this.persistentStorage = new PersistentStorage(nodeInfo.id);
    this.initialize().then(() => {
      this.log(`Node ${this.nodeInfo.id} initialized`);
      this.resetElectionTimeout();
    });
  }

  private async initialize(): Promise<void> {
    await this.persistentStorage.init();
    const { currentTerm, votedFor } = await this.persistentStorage.loadState();
    this.currentTerm = currentTerm;
    this.votedFor = votedFor;

    const snapshot = await this.persistentStorage.loadSnapshot();
    if (snapshot) {
      this.keyValueStore = new Map(Object.entries(snapshot.data));
      this.lastSnapshotIndex = snapshot.lastIncludedIndex;
      this.lastSnapshotTerm = snapshot.lastIncludedTerm;
      this.commitIndex = snapshot.lastIncludedIndex;
      this.lastApplied = snapshot.lastIncludedIndex;
    }

    this.logEntries = await this.persistentStorage.loadLog();
    this.logEntries = this.logEntries.filter(
      (entry) => entry.index > this.lastSnapshotIndex
    );
  }

  private log(message: string): void {
    console.log(
      `[${new Date().toISOString()}] [${this.nodeInfo.id}] [${
        this.state
      }] ${message}`
    );
  }

  private resetElectionTimeout(): void {
    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
    }

    const timeout =
      RaftNode.MIN_ELECTION_TIMEOUT +
      Math.random() *
        (RaftNode.MAX_ELECTION_TIMEOUT - RaftNode.MIN_ELECTION_TIMEOUT);

    this.electionTimeout = setTimeout(() => {
      if (this.state !== NodeState.LEADER) {
        this.startElection();
      }
    }, timeout);
  }

  private async startElection(): Promise<void> {
    if (this.state === NodeState.LEADER) {
      return;
    }

    this.state = NodeState.CANDIDATE;
    this.currentTerm++;
    this.votedFor = this.nodeInfo.id;
    this.votes.clear();
    this.votes.add(this.nodeInfo.id);
    this.leaderId = null;

    await this.persistentStorage.saveState(this.currentTerm, this.votedFor);
    this.log(`Starting election for term ${this.currentTerm}`);
    this.resetElectionTimeout();

    const lastLogIndex =
      this.logEntries.length > 0
        ? this.logEntries[this.logEntries.length - 1].index
        : this.lastSnapshotIndex;
    const lastLogTerm =
      this.logEntries.length > 0
        ? this.logEntries[this.logEntries.length - 1].term
        : this.lastSnapshotTerm;

    const voteRequest: VoteRequest = {
      term: this.currentTerm,
      candidateId: this.nodeInfo.id,
      lastLogIndex,
      lastLogTerm,
    };

    const nodesToRequestVoteFrom: NodeInfo[] = [];
    const healthCheckPromises = this.clusterNodes
      .filter((node) => node.id !== this.nodeInfo.id)
      .map(async (node) => {
        try {
          // Perform a quick health check or assume reachable if not explicitly removing.
          // For simplicity here, we'll try to request from all configured nodes.
          // A more optimized approach might skip nodes known to be down for a long time,
          // but the quorum MUST be based on this.clusterNodes.length.
          nodesToRequestVoteFrom.push(node);
        } catch (error) {
          this.log(
            `Node ${node.id} might be down, but will still be part of quorum calculation.`
          );
        }
      });

    // For this fix, we will attempt to request votes from all other configured nodes.
    // The original health check logic that modified this.clusterNodes is removed.
    // await Promise.allSettled(healthCheckPromises); // This was part of the removed logic

    const votePromises = this.clusterNodes // Iterate over the definitive cluster list
      .filter((node) => node.id !== this.nodeInfo.id)
      .map((node) => this.requestVote(node, voteRequest));

    try {
      await Promise.allSettled(votePromises);

      if (this.state !== NodeState.CANDIDATE) {
        return;
      }

      // Majority is based on the total number of nodes in the configured cluster.
      const majorityNeeded = Math.floor(this.clusterNodes.length / 2) + 1;
      if (this.votes.size >= majorityNeeded) {
        this.becomeLeader();
      } else {
        this.state = NodeState.FOLLOWER;
        this.votedFor = null;
        await this.persistentStorage.saveState(this.currentTerm, this.votedFor);
        this.resetElectionTimeout();
        this.log(
          `Election failed - only got ${this.votes.size} votes, needed ${majorityNeeded} from ${this.clusterNodes.length} configured nodes`
        );
      }
    } catch (error) {
      this.log(`Election error: ${error}`);
      this.state = NodeState.FOLLOWER;
      this.votedFor = null;
      await this.persistentStorage.saveState(this.currentTerm, this.votedFor);
      this.resetElectionTimeout();
    }
  }

  private async requestVote(
    node: NodeInfo,
    request: VoteRequest
  ): Promise<void> {
    try {
      const response = await axios.post<VoteResponse>(
        `http://${node.host}:${node.port}/raft/vote`,
        request,
        { timeout: RaftNode.VOTE_REQUEST_TIMEOUT }
      );

      if (
        this.state !== NodeState.CANDIDATE ||
        this.currentTerm !== request.term
      ) {
        return;
      }

      if (response.data.term > this.currentTerm) {
        this.currentTerm = response.data.term;
        this.votedFor = null;
        this.state = NodeState.FOLLOWER;
        this.leaderId = null;
        await this.persistentStorage.saveState(this.currentTerm, this.votedFor);
        this.resetElectionTimeout();
        this.log(
          `Stepping down due to higher term ${response.data.term} from ${node.id}`
        );
      } else if (
        response.data.voteGranted &&
        response.data.term === this.currentTerm
      ) {
        this.votes.add(node.id);
        this.log(
          `Received vote from ${node.id} (${this.votes.size}/${this.clusterNodes.length})`
        );
      }
    } catch (error) {
      this.log(
        `Failed to get vote from ${node.id}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private becomeLeader(): void {
    if (this.state !== NodeState.CANDIDATE) {
      return;
    }

    this.state = NodeState.LEADER;
    this.leaderId = this.nodeInfo.id;

    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
      this.electionTimeout = null;
    }

    this.log(`Became leader for term ${this.currentTerm}`);

    this.nextIndex.clear();
    this.matchIndex.clear();

    for (const node of this.clusterNodes) {
      if (node.id !== this.nodeInfo.id) {
        this.nextIndex.set(
          node.id,
          this.logEntries.length > 0
            ? this.logEntries[this.logEntries.length - 1].index + 1
            : this.lastSnapshotIndex + 1
        );
        this.matchIndex.set(node.id, this.lastSnapshotIndex);
      }
    }

    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.state === NodeState.LEADER) {
        this.sendHeartbeats();
      } else {
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
      }
    }, RaftNode.HEARTBEAT_INTERVAL);
  }

  private async sendHeartbeats(): Promise<void> {
    const promises = this.clusterNodes
      .filter((node) => node.id !== this.nodeInfo.id)
      .map((node) => this.sendAppendEntries(node));

    await Promise.allSettled(promises);
  }

  private async sendAppendEntries(node: NodeInfo): Promise<void> {
    const nextIndex = this.nextIndex.get(node.id) || 0;
    if (nextIndex <= this.lastSnapshotIndex && this.lastSnapshotIndex >= 0) {
      await this.sendSnapshot(node);
      return;
    }

    const prevLogIndex = nextIndex - 1;
    const prevLogTerm =
      prevLogIndex >= 0
        ? prevLogIndex <= this.lastSnapshotIndex
          ? this.lastSnapshotTerm
          : this.logEntries[prevLogIndex - this.lastSnapshotIndex - 1].term
        : 0;
    const entries =
      nextIndex <= this.lastSnapshotIndex
        ? []
        : this.logEntries.slice(nextIndex - this.lastSnapshotIndex - 1);

    const request: AppendEntriesRequest = {
      term: this.currentTerm,
      leaderId: this.nodeInfo.id,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex,
    };

    try {
      const response = await axios.post<AppendEntriesResponse>(
        `http://${node.host}:${node.port}/raft/append`,
        request,
        { timeout: 50 }
      );

      if (this.state !== NodeState.LEADER) {
        return;
      }

      if (response.data.term > this.currentTerm) {
        this.currentTerm = response.data.term;
        this.state = NodeState.FOLLOWER;
        this.votedFor = null;
        this.leaderId = null;
        await this.persistentStorage.saveState(this.currentTerm, this.votedFor);
        this.resetElectionTimeout();

        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }

        this.log(
          `Stepping down as leader due to higher term ${response.data.term} from ${node.id}`
        );
      } else if (response.data.success) {
        this.nextIndex.set(node.id, nextIndex + entries.length);
        this.matchIndex.set(node.id, nextIndex + entries.length - 1);
        this.updateCommitIndex();
      } else {
        this.nextIndex.set(
          node.id,
          Math.max(this.lastSnapshotIndex + 1, nextIndex - 1)
        );
      }
    } catch (error) {
      // Node is unreachable
    }
  }

  private async sendSnapshot(node: NodeInfo): Promise<void> {
    const snapshot = await this.persistentStorage.loadSnapshot();
    if (!snapshot) return;

    const request: AppendEntriesRequest = {
      term: this.currentTerm,
      leaderId: this.nodeInfo.id,
      prevLogIndex: this.lastSnapshotIndex,
      prevLogTerm: this.lastSnapshotTerm,
      entries: [],
      leaderCommit: this.commitIndex,
      snapshot,
    };

    try {
      const response = await axios.post<AppendEntriesResponse>(
        `http://${node.host}:${node.port}/raft/append`,
        request,
        { timeout: 100 }
      );

      if (response.data.success) {
        this.nextIndex.set(node.id, this.lastSnapshotIndex + 1);
        this.matchIndex.set(node.id, this.lastSnapshotIndex);
      }
    } catch (error) {
      this.log(
        `Failed to send snapshot to ${node.id}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private async createSnapshot(): Promise<void> {
    if (this.logEntries.length < RaftNode.SNAPSHOT_THRESHOLD) return;

    const lastIndex = this.logEntries[this.logEntries.length - 1].index;
    const lastTerm = this.logEntries[this.logEntries.length - 1].term;

    const snapshot: Snapshot = {
      lastIncludedIndex: lastIndex,
      lastIncludedTerm: lastTerm,
      data: Object.fromEntries(this.keyValueStore),
    };

    await this.persistentStorage.saveSnapshot(snapshot);
    // Trim logs up to lastIndex
    this.logEntries = this.logEntries.filter(
      (entry) => entry.index > lastIndex
    );
    await this.persistentStorage.saveLog(this.logEntries);

    this.lastSnapshotIndex = lastIndex;
    this.lastSnapshotTerm = lastTerm;
    this.log(`Created snapshot up to index ${lastIndex}`);
  }

  private updateCommitIndex(): void {
    if (this.state !== NodeState.LEADER) return;

    const majorityNeeded = Math.floor(this.clusterNodes.length / 2) + 1;

    for (
      let n = this.commitIndex + 1;
      n <= this.lastSnapshotIndex + this.logEntries.length;
      n++
    ) {
      if (n <= this.lastSnapshotIndex) continue;
      if (
        this.logEntries[n - this.lastSnapshotIndex - 1].term ===
        this.currentTerm
      ) {
        let count = 1; // Count self

        for (const node of this.clusterNodes) {
          if (node.id !== this.nodeInfo.id) {
            const matchedIndexForNode = this.matchIndex.get(node.id);
            if (matchedIndexForNode !== undefined && matchedIndexForNode >= n) {
              count++;
            }
          }
        }

        if (count >= majorityNeeded) {
          this.commitIndex = n;
          this.log(
            `Commit index updated to ${this.commitIndex}. Replicated on ${count}/${this.clusterNodes.length} nodes.`
          );
          this.applyCommittedEntries();
          this.createSnapshot().catch((error) =>
            this.log(`Snapshot creation failed: ${error}`)
          );
        }
      }
    }
  }

  private applyCommittedEntries(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      if (this.lastApplied <= this.lastSnapshotIndex) continue;
      const entry =
        this.logEntries[this.lastApplied - this.lastSnapshotIndex - 1];
      const result = this.applyCommand(entry.command);
      this.commandResults.set(entry.index, result);
    }
  }

  private applyCommand(command: Command): any {
    switch (command.type) {
      case "SET":
        this.keyValueStore.set(command.key!, command.value!);
        this.log(`Applied SET ${command.key} = ${command.value}`);
        return "OK";

      case "GET":
        const getValue = this.keyValueStore.get(command.key!) || "";
        return getValue;

      case "DEL":
        const deletedValue = this.keyValueStore.get(command.key!) || "";
        this.keyValueStore.delete(command.key!);
        this.log(`Applied DEL ${command.key}`);
        return deletedValue;

      case "APPEND":
        const currentValue = this.keyValueStore.get(command.key!) || "";
        const newValue = currentValue + command.value!;
        this.keyValueStore.set(command.key!, newValue);
        this.log(`Applied APPEND ${command.key} += ${command.value}`);
        return "OK";

      case "STRLN":
        const strValue = this.keyValueStore.get(command.key!) || "";
        return strValue.length;

      case "PING":
        return "PONG";

      case "ADD_NODE":
        if (command.nodeInfo) {
          this.applyAddNode(command.nodeInfo);
          this.log(`Applied ADD_NODE ${command.nodeInfo.id}`);
          return "OK";
        }
        throw new Error("Invalid ADD_NODE command");

      case "REMOVE_NODE":
        if (command.nodeId) {
          this.applyRemoveNode(command.nodeId);
          this.log(`Applied REMOVE_NODE ${command.nodeId}`);
          return "OK";
        }
        throw new Error("Invalid REMOVE_NODE command");

      case "REQUEST_LOG":
        return this.getLog();

      default:
        throw new Error(`Unknown command type: ${command.type}`);
    }
  }

  private applyAddNode(nodeInfo: NodeInfo): void {
    if (!this.clusterNodes.find((node) => node.id === nodeInfo.id)) {
      this.clusterNodes.push(nodeInfo);
      if (this.state === NodeState.LEADER) {
        this.nextIndex.set(
          nodeInfo.id,
          this.logEntries.length > 0
            ? this.logEntries[this.logEntries.length - 1].index + 1
            : this.lastSnapshotIndex + 1
        );
        this.matchIndex.set(nodeInfo.id, this.lastSnapshotIndex);
      }
    }
  }

  private applyRemoveNode(nodeId: string): void {
    this.clusterNodes = this.clusterNodes.filter((node) => node.id !== nodeId);
    this.nextIndex.delete(nodeId);
    this.matchIndex.delete(nodeId);
  }

  public async addNodeConsensus(nodeInfo: NodeInfo): Promise<any> {
    const command: Command = {
      type: "ADD_NODE",
      nodeInfo,
    };
    return this.executeCommand(command);
  }

  public async removeNodeConsensus(nodeId: string): Promise<any> {
    const command: Command = {
      type: "REMOVE_NODE",
      nodeId,
    };
    return this.executeCommand(command);
  }

  public handleVoteRequest(request: VoteRequest): VoteResponse {
    if (request.term > this.currentTerm) {
      this.currentTerm = request.term;
      this.votedFor = null;
      this.state = NodeState.FOLLOWER;
      this.leaderId = null;

      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      this.persistentStorage
        .saveState(this.currentTerm, this.votedFor)
        .catch((error) => this.log(`Failed to save state: ${error}`));
      this.resetElectionTimeout();
      this.log(
        `Updated term to ${this.currentTerm} due to vote request from ${request.candidateId}`
      );
    }

    const lastLogIndex =
      this.logEntries.length > 0
        ? this.logEntries[this.logEntries.length - 1].index
        : this.lastSnapshotIndex;
    const lastLogTerm =
      this.logEntries.length > 0
        ? this.logEntries[this.logEntries.length - 1].term
        : this.lastSnapshotTerm;

    const logUpToDate =
      request.lastLogTerm > lastLogTerm ||
      (request.lastLogTerm === lastLogTerm &&
        request.lastLogIndex >= lastLogIndex);

    const voteGranted =
      request.term === this.currentTerm &&
      (this.votedFor === null || this.votedFor === request.candidateId) &&
      logUpToDate;

    if (voteGranted) {
      this.votedFor = request.candidateId;
      this.persistentStorage
        .saveState(this.currentTerm, this.votedFor)
        .catch((error) => this.log(`Failed to save state: ${error}`));
      this.resetElectionTimeout();
      this.log(
        `Granted vote to ${request.candidateId} for term ${request.term}`
      );
    } else {
      this.log(
        `Denied vote to ${request.candidateId} for term ${request.term} (already voted for: ${this.votedFor}, log up-to-date: ${logUpToDate})`
      );
    }

    return {
      term: this.currentTerm,
      voteGranted,
    };
  }

  public handleAppendEntries(
    request: AppendEntriesRequest
  ): AppendEntriesResponse {
    if (request.term > this.currentTerm) {
      this.currentTerm = request.term;
      this.votedFor = null;
      this.state = NodeState.FOLLOWER;
      this.leaderId = null;

      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      this.persistentStorage
        .saveState(this.currentTerm, this.votedFor)
        .catch((error) => this.log(`Failed to save state: ${error}`));
    }

    if (request.term === this.currentTerm) {
      this.state = NodeState.FOLLOWER;
      this.leaderId = request.leaderId;
      this.resetElectionTimeout();

      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
    }

    if (request.term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }

    // Handle snapshot installation
    if (request.snapshot) {
      if (request.prevLogIndex <= this.lastSnapshotIndex) {
        return { term: this.currentTerm, success: true }; // Already have this snapshot or newer
      }

      this.keyValueStore = new Map(Object.entries(request.snapshot.data));
      this.lastSnapshotIndex = request.snapshot.lastIncludedIndex;
      this.lastSnapshotTerm = request.snapshot.lastIncludedTerm;
      this.commitIndex = request.snapshot.lastIncludedIndex;
      this.lastApplied = request.snapshot.lastIncludedIndex;
      this.logEntries = this.logEntries.filter(
        (entry) => entry.index > this.lastSnapshotIndex
      );

      this.persistentStorage
        .saveSnapshot(request.snapshot)
        .catch((error) => this.log(`Failed to save snapshot: ${error}`));
      this.persistentStorage
        .saveLog(this.logEntries)
        .catch((error) => this.log(`Failed to save log: ${error}`));

      return { term: this.currentTerm, success: true };
    }

    // Check log consistency
    if (request.prevLogIndex >= 0) {
      if (request.prevLogIndex <= this.lastSnapshotIndex) {
        if (request.prevLogTerm !== this.lastSnapshotTerm) {
          return { term: this.currentTerm, success: false };
        }
      } else if (
        this.logEntries.length + this.lastSnapshotIndex <
          request.prevLogIndex ||
        this.logEntries[request.prevLogIndex - this.lastSnapshotIndex - 1]
          ?.term !== request.prevLogTerm
      ) {
        return { term: this.currentTerm, success: false };
      }
    }

    // Append new entries
    let index = request.prevLogIndex + 1;
    for (const entry of request.entries) {
      if (index <= this.lastSnapshotIndex) {
        index++;
        continue;
      }
      const logIndex = index - this.lastSnapshotIndex - 1;
      if (
        logIndex < this.logEntries.length &&
        this.logEntries[logIndex].term !== entry.term
      ) {
        this.logEntries = this.logEntries.slice(0, logIndex);
      }
      if (logIndex >= this.logEntries.length) {
        this.logEntries.push({ ...entry, index });
      }
      index++;
    }

    // Persist logs
    this.persistentStorage
      .saveLog(this.logEntries)
      .catch((error) => this.log(`Failed to save log: ${error}`));

    // Update commit index
    if (request.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(
        request.leaderCommit,
        this.lastSnapshotIndex + this.logEntries.length
      );
      this.applyCommittedEntries();
    }

    return { term: this.currentTerm, success: true };
  }

  public async executeCommand(command: Command): Promise<any> {
    if (this.state !== NodeState.LEADER) {
      throw new Error("Not a leader");
    }

    if (
      command.type === "GET" ||
      command.type === "STRLN" ||
      command.type === "REQUEST_LOG"
    ) {
      return this.executeReadCommand(command);
    }

    if (command.type === "PING") {
      return this.applyCommand(command);
    }

    const entry: LogEntry = {
      term: this.currentTerm,
      index: this.lastSnapshotIndex + this.logEntries.length + 1,
      command,
      timestamp: Date.now(),
    };

    this.logEntries.push(entry);
    this.persistentStorage
      .saveLog(this.logEntries)
      .catch((error) => this.log(`Failed to save log: ${error}`));
    this.log(`Added log entry: ${JSON.stringify(command)}`);

    return this.waitForCommitment(entry);
  }

  private async executeReadCommand(command: Command): Promise<any> {
    const readIndex = this.commitIndex;
    await this.confirmLeadership();
    return this.applyCommand(command);
  }

  private async confirmLeadership(): Promise<void> {
    if (this.clusterNodes.length === 1) {
      return;
    }

    const promises = this.clusterNodes
      .filter((node) => node.id !== this.nodeInfo.id)
      .map((node) => this.sendHeartbeatToNode(node));

    const results = await Promise.allSettled(promises);
    const successCount =
      results.filter((result) => result.status === "fulfilled").length + 1;

    const majorityNeeded = Math.floor(this.clusterNodes.length / 2) + 1;
    if (successCount < majorityNeeded) {
      throw new Error("Lost leadership - cannot confirm majority");
    }
  }

  private async sendHeartbeatToNode(node: NodeInfo): Promise<void> {
    const nextIndex = this.nextIndex.get(node.id) || 0;
    const prevLogIndex = nextIndex - 1;
    const prevLogTerm =
      prevLogIndex >= 0
        ? prevLogIndex <= this.lastSnapshotIndex
          ? this.lastSnapshotTerm
          : this.logEntries[prevLogIndex - this.lastSnapshotIndex - 1].term
        : 0;

    const request: AppendEntriesRequest = {
      term: this.currentTerm,
      leaderId: this.nodeInfo.id,
      prevLogIndex,
      prevLogTerm,
      entries: [],
      leaderCommit: this.commitIndex,
    };

    const response = await axios.post<AppendEntriesResponse>(
      `http://${node.host}:${node.port}/raft/append`,
      request,
      { timeout: 100 }
    );

    if (!response.data.success || response.data.term > this.currentTerm) {
      throw new Error("Heartbeat failed");
    }
  }

  private waitForCommitment(entry: LogEntry): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.commandResults.delete(entry.index);
        reject(new Error(`Command timeout for entry index ${entry.index}`));
      }, 5000);

      const checkApplied = () => {
        if (this.lastApplied >= entry.index) {
          clearTimeout(timeoutId);
          const result = this.commandResults.get(entry.index);
          this.commandResults.delete(entry.index);
          resolve(result);
        } else if (this.state !== NodeState.LEADER) {
          clearTimeout(timeoutId);
          this.commandResults.delete(entry.index);
          reject(new Error(`Lost leadership for entry index ${entry.index}`));
        } else {
          setTimeout(checkApplied, 5);
        }
      };

      checkApplied();
    });
  }

  public getState(): NodeState {
    return this.state;
  }

  public getLeaderInfo(): NodeInfo | null {
    if (this.leaderId) {
      return (
        this.clusterNodes.find((node) => node.id === this.leaderId) || null
      );
    }
    return null;
  }

  public getLog(): LogEntry[] {
    return [...this.logEntries];
  }

  public addNode(nodeInfo: NodeInfo): void {
    this.log(
      "WARNING: Using deprecated addNode. Use addNodeConsensus for Raft compliance."
    );
    this.applyAddNode(nodeInfo);
  }

  public removeNode(nodeId: string): void {
    this.log(
      "WARNING: Using deprecated removeNode. Use removeNodeConsensus for Raft compliance."
    );
    this.applyRemoveNode(nodeId);
  }

  public shutdown(): void {
    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
      this.electionTimeout = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.log("Node shutdown");
  }
}
