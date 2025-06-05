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

  private static readonly HEARTBEAT_INTERVAL = 750;
  private static readonly MIN_ELECTION_TIMEOUT = 2000;
  private static readonly MAX_ELECTION_TIMEOUT = 4000;
  private static readonly VOTE_REQUEST_TIMEOUT = 1000;
  private static readonly SNAPSHOT_THRESHOLD = 100;
  private static readonly APPEND_ENTRIES_TIMEOUT = 1000;
  private static readonly COMMAND_COMMIT_TIMEOUT = 10000;

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

  private async retryRpc<T>(
    operation: () => Promise<T>,
    description: string,
    maxRetries: number = 2,
    delayMs: number = 200
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (attempt < maxRetries) {
          this.log(
            `${description} failed (attempt ${attempt + 1}/${
              maxRetries + 1
            }): ${errorMsg}. Retrying in ${delayMs}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          this.log(
            `${description} failed after ${
              maxRetries + 1
            } attempts: ${errorMsg}`
          );
        }
      }
    }

    throw lastError;
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
          nodesToRequestVoteFrom.push(node);
        } catch (error) {
          this.log(
            `Node ${node.id} might be down, but will still be part of quorum calculation.`
          );
        }
      });

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

    this.nextIndex.clear();
    this.matchIndex.clear();

    this.log(`Became leader for term ${this.currentTerm}`);

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
        { timeout: RaftNode.APPEND_ENTRIES_TIMEOUT }
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
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`Failed to send AppendEntries to ${node.id}: ${errorMsg}`);

      // Only decrease nextIndex for log inconsistency, not for network errors
      if (!errorMsg.includes("timeout") && !errorMsg.includes("ECONNREFUSED")) {
        this.nextIndex.set(
          node.id,
          Math.max(
            this.lastSnapshotIndex + 1,
            (this.nextIndex.get(node.id) || 0) - 1
          )
        );
      }
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
        { timeout: 1000 }
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
        let count = 1;

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

  public async handleAppendEntries(
    request: AppendEntriesRequest
  ): Promise<AppendEntriesResponse> {
    if (request.term > this.currentTerm) {
      this.currentTerm = request.term;
      this.votedFor = null;
      this.state = NodeState.FOLLOWER;
      this.leaderId = null;

      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      try {
        await this.persistentStorage.saveState(this.currentTerm, this.votedFor);
      } catch (error) {
        this.log(`Failed to save state: ${error}`);
      }
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

    if (request.snapshot) {
      if (
        request.prevLogIndex <= this.lastSnapshotIndex &&
        this.lastSnapshotIndex !== -1 &&
        request.snapshot.lastIncludedIndex <= this.lastSnapshotIndex
      ) {
        this.log(
          `Received snapshot for index ${request.snapshot.lastIncludedIndex}, but already have up to ${this.lastSnapshotIndex}. Ignoring.`
        );
        return { term: this.currentTerm, success: true };
      }

      this.log(
        `Installing snapshot. Last included index: ${request.snapshot.lastIncludedIndex}, term: ${request.snapshot.lastIncludedTerm}`
      );
      this.keyValueStore = new Map(Object.entries(request.snapshot.data));
      this.lastSnapshotIndex = request.snapshot.lastIncludedIndex;
      this.lastSnapshotTerm = request.snapshot.lastIncludedTerm;
      this.commitIndex = Math.max(
        this.commitIndex,
        request.snapshot.lastIncludedIndex
      );
      this.lastApplied = Math.max(
        this.lastApplied,
        request.snapshot.lastIncludedIndex
      );

      this.logEntries = this.logEntries.filter(
        (entry) => entry.index > this.lastSnapshotIndex
      );

      try {
        await this.persistentStorage.saveSnapshot(request.snapshot);
        await this.persistentStorage.saveLog(this.logEntries);
        this.log(
          `Snapshot installed and log trimmed up to index ${this.lastSnapshotIndex}`
        );
      } catch (error) {
        this.log(
          `Failed to save snapshot or log after snapshot installation: ${error}`
        );
        return { term: this.currentTerm, success: false };
      }

      return { term: this.currentTerm, success: true };
    }

    // Check log consistency
    if (request.prevLogIndex >= 0) {
      if (
        request.prevLogIndex >
        this.lastSnapshotIndex + this.logEntries.length
      ) {
        this.log(
          `Rejecting AppendEntries: prevLogIndex ${
            request.prevLogIndex
          } is beyond current log length ${
            this.lastSnapshotIndex + this.logEntries.length
          }`
        );
        return { term: this.currentTerm, success: false };
      }
      if (request.prevLogIndex === this.lastSnapshotIndex) {
        if (
          this.lastSnapshotIndex !== -1 &&
          request.prevLogTerm !== this.lastSnapshotTerm
        ) {
          this.log(
            `Rejecting AppendEntries: prevLogTerm ${request.prevLogTerm} at index ${request.prevLogIndex} (snapshot boundary) does not match follower's lastSnapshotTerm ${this.lastSnapshotTerm}`
          );
          return { term: this.currentTerm, success: false };
        }
      } else if (request.prevLogIndex > this.lastSnapshotIndex) {
        const localEntryArrayIndex =
          request.prevLogIndex - this.lastSnapshotIndex - 1;
        if (
          localEntryArrayIndex < 0 ||
          localEntryArrayIndex >= this.logEntries.length ||
          this.logEntries[localEntryArrayIndex]?.term !== request.prevLogTerm
        ) {
          this.log(
            `Rejecting AppendEntries: Log inconsistency at prevLogIndex ${request.prevLogIndex}. Follower's term: ${this.logEntries[localEntryArrayIndex]?.term}, Leader's term: ${request.prevLogTerm}`
          );
          return { term: this.currentTerm, success: false };
        }
      }
    }

    // Append new entries
    let newEntriesPersisted = false;
    if (request.entries && request.entries.length > 0) {
      let currentLogArrayIndex: number;

      if (request.prevLogIndex < this.lastSnapshotIndex) {
        currentLogArrayIndex = 0;
      } else {
        currentLogArrayIndex = request.prevLogIndex - this.lastSnapshotIndex;
      }

      for (const entry of request.entries) {
        const expectedAbsoluteIndexForThisSlot =
          this.lastSnapshotIndex + 1 + currentLogArrayIndex;
        if (expectedAbsoluteIndexForThisSlot !== entry.index) {
          this.log(
            `Error: Mismatch between calculated absolute index ${expectedAbsoluteIndexForThisSlot} for slot ${currentLogArrayIndex} and entry's given index ${entry.index}.`
          );
          this.log(
            `Details: request.prevLogIndex=${request.prevLogIndex}, follower.lastSnapshotIndex=${this.lastSnapshotIndex}, follower.logEntries.length=${this.logEntries.length}`
          );
          return { term: this.currentTerm, success: false };
        }

        if (currentLogArrayIndex < this.logEntries.length) {
          if (this.logEntries[currentLogArrayIndex].term !== entry.term) {
            this.log(
              `Conflict at absolute index ${entry.index} (array index ${currentLogArrayIndex}). Truncating log from this point.`
            );
            this.logEntries = this.logEntries.slice(0, currentLogArrayIndex);
            this.logEntries.push(entry);
            newEntriesPersisted = true;
          }
        } else {
          if (currentLogArrayIndex === this.logEntries.length) {
            this.logEntries.push(entry);
            newEntriesPersisted = true;
          } else {
            this.log(
              `Error: Gap detected when trying to append. Target array index ${currentLogArrayIndex}, log length ${this.logEntries.length}. Absolute index ${entry.index}.`
            );
            return { term: this.currentTerm, success: false };
          }
        }
        currentLogArrayIndex++;
      }
    }

    if (newEntriesPersisted) {
      try {
        await this.persistentStorage.saveLog(this.logEntries);
        this.log(
          `Appended ${request.entries?.length || 0} entries. Log persisted.`
        );
      } catch (error) {
        this.log(`Failed to save log after appending entries: ${error}`);
        return { term: this.currentTerm, success: false };
      }
    }

    if (request.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(
        request.leaderCommit,
        this.lastSnapshotIndex + this.logEntries.length
      );
      this.log(`Follower commitIndex updated to ${this.commitIndex}`);
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
    try {
      await this.persistentStorage.saveLog(this.logEntries);
      this.log(`Added log entry: ${JSON.stringify(command)} and persisted.`);
    } catch (error) {
      this.log(`Failed to save log: ${error}. Command will not be processed.`);
      this.logEntries.pop();
      throw new Error(
        `Failed to persist log entry: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

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

    // Track when we started the confirmation
    const startTime = Date.now();

    // Track which nodes have responded successfully
    const successfulNodes = new Set<string>();
    successfulNodes.add(this.nodeInfo.id); // Leader counts itself

    const majorityNeeded = Math.floor(this.clusterNodes.length / 2) + 1;
    const maxWaitTime = 2000; // Maximum time to wait for responses

    // Try to get responses from followers
    const heartbeatPromises = this.clusterNodes
      .filter((node) => node.id !== this.nodeInfo.id)
      .map(async (node) => {
        try {
          await this.sendHeartbeatToNode(node);
          successfulNodes.add(node.id);
        } catch (error) {
          // Log but don't fail immediately
          this.log(
            `Failed to confirm leadership with ${node.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      });

    // Start all heartbeats in parallel
    await Promise.allSettled(heartbeatPromises);

    // Check if we have majority
    if (successfulNodes.size < majorityNeeded) {
      throw new Error(
        `Cannot confirm leadership - only reached ${successfulNodes.size}/${this.clusterNodes.length} nodes, need ${majorityNeeded}`
      );
    }

    if (this.state !== NodeState.LEADER) {
      throw new Error("Lost leadership during confirmation");
    }
  }

  // Replace your sendHeartbeatToNode method
  private async sendHeartbeatToNode(node: NodeInfo): Promise<void> {
    // Prepare the request as before
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

    // Use retry logic
    try {
      await this.retryRpc(
        async () => {
          const response = await axios.post<AppendEntriesResponse>(
            `http://${node.host}:${node.port}/raft/append`,
            request,
            { timeout: RaftNode.APPEND_ENTRIES_TIMEOUT }
          );

          // Check for term and success
          if (response.data.term > this.currentTerm) {
            this.currentTerm = response.data.term;
            this.state = NodeState.FOLLOWER;
            this.votedFor = null;
            this.leaderId = null;
            await this.persistentStorage.saveState(
              this.currentTerm,
              this.votedFor
            );
            this.resetElectionTimeout();

            if (this.heartbeatInterval) {
              clearInterval(this.heartbeatInterval);
              this.heartbeatInterval = null;
            }

            throw new Error(
              `Stepping down due to higher term ${response.data.term}`
            );
          }

          if (!response.data.success) {
            throw new Error("Heartbeat not successful");
          }

          // Must return void
          return;
        },
        `Heartbeat to ${node.id}`,
        1, // Only retry once for heartbeats
        100 // Shorter delay for heartbeats
      );
    } catch (error) {
      throw error;
    }
  }

  private waitForCommitment(entry: LogEntry): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.commandResults.delete(entry.index);
        reject(new Error(`Command timeout for entry index ${entry.index}`));
      }, RaftNode.COMMAND_COMMIT_TIMEOUT);

      let checkAttempts = 0;
      const maxCheckAttempts = 200; // 1 second assuming 5ms interval

      const checkApplied = () => {
        if (this.lastApplied >= entry.index) {
          clearTimeout(timeoutId);
          const result = this.commandResults.get(entry.index);
          this.commandResults.delete(entry.index);
          resolve(result);
        } else if (this.state !== NodeState.LEADER) {
          clearTimeout(timeoutId);
          this.commandResults.delete(entry.index);
          const leaderInfo = this.getLeaderInfo()
            ? `new leader: ${this.getLeaderInfo()?.id}`
            : "no leader identified";
          reject(
            new Error(
              `Lost leadership for entry index ${entry.index}, ${leaderInfo}`
            )
          );
        } else if (checkAttempts >= maxCheckAttempts) {
          // If checked too many times, log progress but continue waiting for timeout
          this.log(
            `Command still pending: index=${entry.index}, lastApplied=${
              this.lastApplied
            }, commitIndex=${
              this.commitIndex
            }, replication status: ${this.getReplicationStatus(entry.index)}`
          );
          checkAttempts = 0;
          setTimeout(checkApplied, 5);
        } else {
          checkAttempts++;
          setTimeout(checkApplied, 5);
        }
      };

      checkApplied();
    });
  }

  private getReplicationStatus(entryIndex: number): string {
    const replicationCounts = { total: this.clusterNodes.length, success: 1 }; // 1 for self

    for (const node of this.clusterNodes) {
      if (node.id !== this.nodeInfo.id) {
        const matchIndex = this.matchIndex.get(node.id) || -1;
        if (matchIndex >= entryIndex) {
          replicationCounts.success++;
        }
      }
    }

    return `${replicationCounts.success}/${replicationCounts.total} nodes`;
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
