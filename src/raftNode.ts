import { EventEmitter } from 'events';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  NodeInfo,
  LogEntry,
  Command,
  VoteRequest,
  VoteResponse,
  AppendEntriesRequest,
  AppendEntriesResponse,
  NodeState,
  ClientRequest,
  ClientResponse
} from './types';

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

  private static readonly HEARTBEAT_INTERVAL = 100; // 100ms
  private static readonly MIN_ELECTION_TIMEOUT = 300; // 300ms
  private static readonly MAX_ELECTION_TIMEOUT = 500; // 500ms

  constructor(
    private nodeInfo: NodeInfo,
    private clusterNodes: NodeInfo[]
  ) {
    super();
    this.resetElectionTimeout();
    this.log(`Node ${this.nodeInfo.id} initialized`);
  }

  private log(message: string): void {
    console.log(`[${new Date().toISOString()}] [${this.nodeInfo.id}] [${this.state}] ${message}`);
  }

  private resetElectionTimeout(): void {
    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
    }
    
    const timeout = RaftNode.MIN_ELECTION_TIMEOUT + 
      Math.random() * (RaftNode.MAX_ELECTION_TIMEOUT - RaftNode.MIN_ELECTION_TIMEOUT);
    
    this.electionTimeout = setTimeout(() => {
      this.startElection();
    }, timeout);
  }

  private async startElection(): Promise<void> {
    this.state = NodeState.CANDIDATE;
    this.currentTerm++;
    this.votedFor = this.nodeInfo.id;
    this.votes.clear();
    this.votes.add(this.nodeInfo.id);
    
    this.log(`Starting election for term ${this.currentTerm}`);
    this.resetElectionTimeout();

    const lastLogIndex = this.logEntries.length - 1;
    const lastLogTerm = lastLogIndex >= 0 ? this.logEntries[lastLogIndex].term : 0;

    const voteRequest: VoteRequest = {
      term: this.currentTerm,
      candidateId: this.nodeInfo.id,
      lastLogIndex,
      lastLogTerm
    };

    const votePromises = this.clusterNodes
      .filter(node => node.id !== this.nodeInfo.id)
      .map(node => this.requestVote(node, voteRequest));

    try {
      await Promise.allSettled(votePromises);
      
      const majorityNeeded = Math.floor(this.clusterNodes.length / 2) + 1;
      if (this.votes.size >= majorityNeeded && this.state === NodeState.CANDIDATE) {
        this.becomeLeader();
      }
    } catch (error) {
      this.log(`Election error: ${error}`);
    }
  }

  private async requestVote(node: NodeInfo, request: VoteRequest): Promise<void> {
    try {
      const response = await axios.post<VoteResponse>(
        `http://${node.host}:${node.port}/raft/vote`,
        request,
        { timeout: 50 }
      );

      if (response.data.term > this.currentTerm) {
        this.currentTerm = response.data.term;
        this.votedFor = null;
        this.state = NodeState.FOLLOWER;
        this.resetElectionTimeout();
      } else if (response.data.voteGranted && this.state === NodeState.CANDIDATE) {
        this.votes.add(node.id);
      }
    } catch (error) {
      // Node is unreachable
    }
  }

  private becomeLeader(): void {
    this.state = NodeState.LEADER;
    this.leaderId = this.nodeInfo.id;
    
    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
    }

    this.log(`Became leader for term ${this.currentTerm}`);

    // Initialize leader state
    this.nextIndex.clear();
    this.matchIndex.clear();
    
    for (const node of this.clusterNodes) {
      if (node.id !== this.nodeInfo.id) {
        this.nextIndex.set(node.id, this.logEntries.length);
        this.matchIndex.set(node.id, -1);
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
      }
    }, RaftNode.HEARTBEAT_INTERVAL);
  }

  private async sendHeartbeats(): Promise<void> {
    const promises = this.clusterNodes
      .filter(node => node.id !== this.nodeInfo.id)
      .map(node => this.sendAppendEntries(node));

    await Promise.allSettled(promises);
  }

  private async sendAppendEntries(node: NodeInfo): Promise<void> {
    const nextIndex = this.nextIndex.get(node.id) || 0;
    const prevLogIndex = nextIndex - 1;
    const prevLogTerm = prevLogIndex >= 0 ? this.logEntries[prevLogIndex].term : 0;
    const entries = this.logEntries.slice(nextIndex);

    const request: AppendEntriesRequest = {
      term: this.currentTerm,
      leaderId: this.nodeInfo.id,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex
    };

    try {
      const response = await axios.post<AppendEntriesResponse>(
        `http://${node.host}:${node.port}/raft/append`,
        request,
        { timeout: 50 }
      );

      if (response.data.term > this.currentTerm) {
        this.currentTerm = response.data.term;
        this.state = NodeState.FOLLOWER;
        this.votedFor = null;
        this.leaderId = null;
        this.resetElectionTimeout();
        
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
        }
      } else if (this.state === NodeState.LEADER) {
        if (response.data.success) {
          this.nextIndex.set(node.id, nextIndex + entries.length);
          this.matchIndex.set(node.id, nextIndex + entries.length - 1);
          this.updateCommitIndex();
        } else {
          this.nextIndex.set(node.id, Math.max(0, nextIndex - 1));
        }
      }
    } catch (error) {
      // Node is unreachable
    }
  }

  private updateCommitIndex(): void {
    if (this.state !== NodeState.LEADER) return;

    for (let n = this.commitIndex + 1; n < this.logEntries.length; n++) {
      if (this.logEntries[n].term === this.currentTerm) {
        let count = 1; // Count self
        
        for (const [nodeId, matchIndex] of this.matchIndex) {
          if (matchIndex >= n) count++;
        }

        const majorityNeeded = Math.floor(this.clusterNodes.length / 2) + 1;
        if (count >= majorityNeeded) {
          this.commitIndex = n;
          this.applyCommittedEntries();
        }
      }
    }
  }

  private applyCommittedEntries(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.logEntries[this.lastApplied];
      const result = this.applyCommand(entry.command); 
      this.commandResults.set(entry.index, result); 
    }
  }

  private applyCommand(command: Command): any {
    switch (command.type) {
      case 'SET':
        this.keyValueStore.set(command.key!, command.value!);
        this.log(`Applied SET ${command.key} = ${command.value}`);
        return 'OK';
      
      case 'GET':
        const getValue = this.keyValueStore.get(command.key!) || '';
        return getValue;
      
      case 'DEL':
        const deletedValue = this.keyValueStore.get(command.key!) || '';
        this.keyValueStore.delete(command.key!);
        this.log(`Applied DEL ${command.key}`);
        return deletedValue;
      
      case 'APPEND':
        const currentValue = this.keyValueStore.get(command.key!) || '';
        const newValue = currentValue + command.value!;
        this.keyValueStore.set(command.key!, newValue);
        this.log(`Applied APPEND ${command.key} += ${command.value}`);
        return 'OK';
      
      case 'STRLN':
        const strValue = this.keyValueStore.get(command.key!) || '';
        return strValue.length;
      
      case 'PING':
        return 'PONG';
        
      // New membership change commands
      case 'ADD_NODE':
        if (command.nodeInfo) {
          this.applyAddNode(command.nodeInfo);
          this.log(`Applied ADD_NODE ${command.nodeInfo.id}`);
          return 'OK';
        }
        throw new Error('Invalid ADD_NODE command');
        
      case 'REMOVE_NODE':
        if (command.nodeId) {
          this.applyRemoveNode(command.nodeId);
          this.log(`Applied REMOVE_NODE ${command.nodeId}`);
          return 'OK';
        }
        throw new Error('Invalid REMOVE_NODE command');
      
      default:
        throw new Error(`Unknown command type: ${command.type}`);
    }
  }

  private applyAddNode(nodeInfo: NodeInfo): void {
    // Only add if not already in cluster
    if (!this.clusterNodes.find(node => node.id === nodeInfo.id)) {
      this.clusterNodes.push(nodeInfo);
      if (this.state === NodeState.LEADER) {
        this.nextIndex.set(nodeInfo.id, this.logEntries.length);
        this.matchIndex.set(nodeInfo.id, 0);
      }
    }
  }

  private applyRemoveNode(nodeId: string): void {
    this.clusterNodes = this.clusterNodes.filter(node => node.id !== nodeId);
    this.nextIndex.delete(nodeId);
    this.matchIndex.delete(nodeId);
  }

  public async addNodeConsensus(nodeInfo: NodeInfo): Promise<any> {
    const command: Command = {
      type: 'ADD_NODE',
      nodeInfo
    };
    return this.executeCommand(command);
  }

  public async removeNodeConsensus(nodeId: string): Promise<any> {
    const command: Command = {
      type: 'REMOVE_NODE',
      nodeId
    };
    return this.executeCommand(command);
  }

  public handleVoteRequest(request: VoteRequest): VoteResponse {
    if (request.term > this.currentTerm) {
      this.currentTerm = request.term;
      this.votedFor = null;
      this.state = NodeState.FOLLOWER;
    }

    const lastLogIndex = this.logEntries.length - 1;
    const lastLogTerm = lastLogIndex >= 0 ? this.logEntries[lastLogIndex].term : 0;

    const logUpToDate = request.lastLogTerm > lastLogTerm || 
      (request.lastLogTerm === lastLogTerm && request.lastLogIndex >= lastLogIndex);

    const voteGranted = request.term === this.currentTerm && 
      (this.votedFor === null || this.votedFor === request.candidateId) && 
      logUpToDate;

    if (voteGranted) {
      this.votedFor = request.candidateId;
      this.resetElectionTimeout();
    }

    this.log(`Vote request from ${request.candidateId}: ${voteGranted ? 'GRANTED' : 'DENIED'}`);

    return {
      term: this.currentTerm,
      voteGranted
    };
  }

  public handleAppendEntries(request: AppendEntriesRequest): AppendEntriesResponse {
    if (request.term > this.currentTerm) {
      this.currentTerm = request.term;
      this.votedFor = null;
    }

    if (request.term === this.currentTerm) {
      this.state = NodeState.FOLLOWER;
      this.leaderId = request.leaderId;
      this.resetElectionTimeout();
    }

    if (request.term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }

    if (request.prevLogIndex >= 0 && 
        (this.logEntries.length <= request.prevLogIndex || 
         this.logEntries[request.prevLogIndex].term !== request.prevLogTerm)) {
      return { term: this.currentTerm, success: false };
    }

    // Append new entries
    let index = request.prevLogIndex + 1;
    for (const entry of request.entries) {
      if (index < this.logEntries.length && this.logEntries[index].term !== entry.term) {
        this.logEntries = this.logEntries.slice(0, index);
      }
      if (index >= this.logEntries.length) {
        this.logEntries.push(entry);
      }
      index++;
    }

    if (request.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(request.leaderCommit, this.logEntries.length - 1);
      this.applyCommittedEntries();
    }

    return { term: this.currentTerm, success: true };
  }

  public async executeCommand(command: Command): Promise<any> {
    if (this.state !== NodeState.LEADER) {
      throw new Error('Not a leader');
    }

    // For read-only commands, use read index for stronger consistency
    if (command.type === 'GET' || command.type === 'STRLN') {
      return this.executeReadCommand(command);
    }
    
    // PING can be executed immediately
    if (command.type === 'PING') {
      return this.applyCommand(command);
    }

    // For write commands, append to log and wait for consensus
    const entry: LogEntry = {
      term: this.currentTerm,
      index: this.logEntries.length,
      command,
      timestamp: Date.now()
    };

    this.logEntries.push(entry);
    this.log(`Added log entry: ${JSON.stringify(command)}`);

    // Improved consensus waiting with event-based mechanism
    return this.waitForCommitment(entry);
  }

  private async executeReadCommand(command: Command): Promise<any> {
    const readIndex = this.commitIndex;
    
    // Send heartbeat to confirm leadership
    await this.confirmLeadership();
    
    // Apply the read command
    return this.applyCommand(command);
  }

  private async confirmLeadership(): Promise<void> {
    if (this.clusterNodes.length === 1) {
      return; // Single node cluster
    }

    const promises = this.clusterNodes
      .filter(node => node.id !== this.nodeInfo.id)
      .map(node => this.sendHeartbeatToNode(node));

    const results = await Promise.allSettled(promises);
    const successCount = results.filter(result => result.status === 'fulfilled').length + 1; // +1 for self
    
    const majorityNeeded = Math.floor(this.clusterNodes.length / 2) + 1;
    if (successCount < majorityNeeded) {
      throw new Error('Lost leadership - cannot confirm majority');
    }
  }

   private async sendHeartbeatToNode(node: NodeInfo): Promise<void> {
    const nextIndex = this.nextIndex.get(node.id) || 0;
    const prevLogIndex = nextIndex - 1;
    const prevLogTerm = prevLogIndex >= 0 ? this.logEntries[prevLogIndex].term : 0;

    const request: AppendEntriesRequest = {
      term: this.currentTerm,
      leaderId: this.nodeInfo.id,
      prevLogIndex,
      prevLogTerm,
      entries: [], // Empty heartbeat
      leaderCommit: this.commitIndex
    };

    const response = await axios.post<AppendEntriesResponse>(
      `http://${node.host}:${node.port}/raft/append`,
      request,
      { timeout: 100 }
    );

    if (!response.data.success || response.data.term > this.currentTerm) {
      throw new Error('Heartbeat failed');
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
      return this.clusterNodes.find(node => node.id === this.leaderId) || null;
    }
    return null;
  }

  public getLog(): LogEntry[] {
    return [...this.logEntries]; // Return copy of logEntries
  }

  public addNode(nodeInfo: NodeInfo): void {
    this.log('WARNING: Using deprecated addNode. Use addNodeConsensus for Raft compliance.');
    this.applyAddNode(nodeInfo);
  }

  public removeNode(nodeId: string): void {
    this.log('WARNING: Using deprecated removeNode. Use removeNodeConsensus for Raft compliance.');
    this.applyRemoveNode(nodeId);
  }

  public shutdown(): void {
    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.log('Node shutdown');
  }
}
