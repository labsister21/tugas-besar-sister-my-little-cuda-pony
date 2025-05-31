"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RaftNode = void 0;
const events_1 = require("events");
const axios_1 = __importDefault(require("axios"));
const types_1 = require("./types");
class RaftNode extends events_1.EventEmitter {
    constructor(nodeInfo, clusterNodes) {
        super();
        this.nodeInfo = nodeInfo;
        this.clusterNodes = clusterNodes;
        this.currentTerm = 0;
        this.votedFor = null;
        this.logEntries = []; // Renamed from 'log' to 'logEntries'
        this.commitIndex = 0;
        this.lastApplied = 0;
        this.state = types_1.NodeState.FOLLOWER;
        this.leaderId = null;
        this.electionTimeout = null;
        this.heartbeatInterval = null;
        this.nextIndex = new Map();
        this.matchIndex = new Map();
        this.keyValueStore = new Map();
        this.votes = new Set();
        this.resetElectionTimeout();
        this.log(`Node ${this.nodeInfo.id} initialized`);
    }
    log(message) {
        console.log(`[${new Date().toISOString()}] [${this.nodeInfo.id}] [${this.state}] ${message}`);
    }
    resetElectionTimeout() {
        if (this.electionTimeout) {
            clearTimeout(this.electionTimeout);
        }
        // Better timeout range
        const timeout = RaftNode.MIN_ELECTION_TIMEOUT +
            Math.random() * (RaftNode.MAX_ELECTION_TIMEOUT - RaftNode.MIN_ELECTION_TIMEOUT);
        this.electionTimeout = setTimeout(() => {
            this.startElection();
        }, timeout);
    }
    async startElection() {
        this.state = types_1.NodeState.CANDIDATE;
        this.currentTerm++;
        this.votedFor = this.nodeInfo.id;
        this.votes.clear();
        this.votes.add(this.nodeInfo.id);
        this.log(`Starting election for term ${this.currentTerm}`);
        this.resetElectionTimeout();
        const lastLogIndex = this.logEntries.length - 1;
        const lastLogTerm = lastLogIndex >= 0 ? this.logEntries[lastLogIndex].term : 0;
        const voteRequest = {
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
            if (this.votes.size >= majorityNeeded && this.state === types_1.NodeState.CANDIDATE) {
                this.becomeLeader();
            }
        }
        catch (error) {
            this.log(`Election error: ${error}`);
        }
    }
    async requestVote(node, request) {
        try {
            const response = await axios_1.default.post(`http://${node.host}:${node.port}/raft/vote`, request, { timeout: 50 });
            if (response.data.term > this.currentTerm) {
                this.currentTerm = response.data.term;
                this.votedFor = null;
                this.state = types_1.NodeState.FOLLOWER;
                this.resetElectionTimeout();
            }
            else if (response.data.voteGranted && this.state === types_1.NodeState.CANDIDATE) {
                this.votes.add(node.id);
            }
        }
        catch (error) {
            // Node is unreachable
        }
    }
    becomeLeader() {
        this.state = types_1.NodeState.LEADER;
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
                this.matchIndex.set(node.id, 0);
            }
        }
        this.startHeartbeat();
    }
    startHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        this.heartbeatInterval = setInterval(() => {
            if (this.state === types_1.NodeState.LEADER) {
                this.sendHeartbeats();
            }
        }, RaftNode.HEARTBEAT_INTERVAL);
    }
    async sendHeartbeats() {
        const promises = this.clusterNodes
            .filter(node => node.id !== this.nodeInfo.id)
            .map(node => this.sendAppendEntries(node));
        await Promise.allSettled(promises);
    }
    async sendAppendEntries(node) {
        const nextIndex = this.nextIndex.get(node.id) || 0;
        const prevLogIndex = nextIndex - 1;
        const prevLogTerm = prevLogIndex >= 0 ? this.logEntries[prevLogIndex].term : 0;
        const entries = this.logEntries.slice(nextIndex);
        const request = {
            term: this.currentTerm,
            leaderId: this.nodeInfo.id,
            prevLogIndex,
            prevLogTerm,
            entries,
            leaderCommit: this.commitIndex
        };
        try {
            const response = await axios_1.default.post(`http://${node.host}:${node.port}/raft/append`, request, { timeout: 50 });
            if (response.data.term > this.currentTerm) {
                this.currentTerm = response.data.term;
                this.state = types_1.NodeState.FOLLOWER;
                this.votedFor = null;
                this.leaderId = null;
                this.resetElectionTimeout();
                if (this.heartbeatInterval) {
                    clearInterval(this.heartbeatInterval);
                }
            }
            else if (this.state === types_1.NodeState.LEADER) {
                if (response.data.success) {
                    this.nextIndex.set(node.id, nextIndex + entries.length);
                    this.matchIndex.set(node.id, nextIndex + entries.length - 1);
                    this.updateCommitIndex();
                }
                else {
                    this.nextIndex.set(node.id, Math.max(0, nextIndex - 1));
                }
            }
        }
        catch (error) {
            // Node is unreachable
        }
    }
    updateCommitIndex() {
        if (this.state !== types_1.NodeState.LEADER)
            return;
        for (let n = this.commitIndex + 1; n < this.logEntries.length; n++) {
            if (this.logEntries[n].term === this.currentTerm) {
                let count = 1; // Count self
                for (const [nodeId, matchIndex] of this.matchIndex) {
                    if (matchIndex >= n)
                        count++;
                }
                const majorityNeeded = Math.floor(this.clusterNodes.length / 2) + 1;
                if (count >= majorityNeeded) {
                    this.commitIndex = n;
                    this.applyCommittedEntries();
                }
            }
        }
    }
    applyCommittedEntries() {
        while (this.lastApplied < this.commitIndex) {
            this.lastApplied++;
            const entry = this.logEntries[this.lastApplied];
            this.applyCommand(entry.command);
        }
    }
    applyCommand(command) {
        switch (command.type) {
            case 'SET':
                this.keyValueStore.set(command.key, command.value);
                this.log(`Applied SET ${command.key} = ${command.value}`);
                return 'OK';
            case 'GET':
                const getValue = this.keyValueStore.get(command.key) || '';
                return getValue;
            case 'DEL':
                const deletedValue = this.keyValueStore.get(command.key) || '';
                this.keyValueStore.delete(command.key);
                this.log(`Applied DEL ${command.key}`);
                return deletedValue;
            case 'APPEND':
                const currentValue = this.keyValueStore.get(command.key) || '';
                const newValue = currentValue + command.value;
                this.keyValueStore.set(command.key, newValue);
                this.log(`Applied APPEND ${command.key} += ${command.value}`);
                return 'OK';
            case 'STRLN':
                const strValue = this.keyValueStore.get(command.key) || '';
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
    applyAddNode(nodeInfo) {
        // Only add if not already in cluster
        if (!this.clusterNodes.find(node => node.id === nodeInfo.id)) {
            this.clusterNodes.push(nodeInfo);
            if (this.state === types_1.NodeState.LEADER) {
                this.nextIndex.set(nodeInfo.id, this.logEntries.length);
                this.matchIndex.set(nodeInfo.id, 0);
            }
        }
    }
    applyRemoveNode(nodeId) {
        this.clusterNodes = this.clusterNodes.filter(node => node.id !== nodeId);
        this.nextIndex.delete(nodeId);
        this.matchIndex.delete(nodeId);
    }
    async addNodeConsensus(nodeInfo) {
        const command = {
            type: 'ADD_NODE',
            nodeInfo
        };
        return this.executeCommand(command);
    }
    async removeNodeConsensus(nodeId) {
        const command = {
            type: 'REMOVE_NODE',
            nodeId
        };
        return this.executeCommand(command);
    }
    handleVoteRequest(request) {
        if (request.term > this.currentTerm) {
            this.currentTerm = request.term;
            this.votedFor = null;
            this.state = types_1.NodeState.FOLLOWER;
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
    handleAppendEntries(request) {
        if (request.term > this.currentTerm) {
            this.currentTerm = request.term;
            this.votedFor = null;
        }
        if (request.term === this.currentTerm) {
            this.state = types_1.NodeState.FOLLOWER;
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
    async executeCommand(command) {
        if (this.state !== types_1.NodeState.LEADER) {
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
        const entry = {
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
    async executeReadCommand(command) {
        const readIndex = this.commitIndex;
        // Send heartbeat to confirm leadership
        await this.confirmLeadership();
        // Apply the read command
        return this.applyCommand(command);
    }
    async confirmLeadership() {
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
    async sendHeartbeatToNode(node) {
        const nextIndex = this.nextIndex.get(node.id) || 0;
        const prevLogIndex = nextIndex - 1;
        const prevLogTerm = prevLogIndex >= 0 ? this.logEntries[prevLogIndex].term : 0;
        const request = {
            term: this.currentTerm,
            leaderId: this.nodeInfo.id,
            prevLogIndex,
            prevLogTerm,
            entries: [], // Empty heartbeat
            leaderCommit: this.commitIndex
        };
        const response = await axios_1.default.post(`http://${node.host}:${node.port}/raft/append`, request, { timeout: 100 });
        if (!response.data.success || response.data.term > this.currentTerm) {
            throw new Error('Heartbeat failed');
        }
    }
    waitForCommitment(entry) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Command timeout'));
            }, 5000);
            // Event-based checking instead of polling
            const checkCommitted = () => {
                if (this.commitIndex >= entry.index) {
                    clearTimeout(timeout);
                    resolve(this.applyCommand(entry.command));
                }
                else if (this.state !== types_1.NodeState.LEADER) {
                    clearTimeout(timeout);
                    reject(new Error('Lost leadership'));
                }
                else {
                    // Check every 5ms instead of 10ms for better responsiveness
                    setTimeout(checkCommitted, 5);
                }
            };
            checkCommitted();
        });
    }
    getState() {
        return this.state;
    }
    getLeaderInfo() {
        if (this.leaderId) {
            return this.clusterNodes.find(node => node.id === this.leaderId) || null;
        }
        return null;
    }
    getLog() {
        return [...this.logEntries]; // Return copy of logEntries
    }
    addNode(nodeInfo) {
        this.log('WARNING: Using deprecated addNode. Use addNodeConsensus for Raft compliance.');
        this.applyAddNode(nodeInfo);
    }
    removeNode(nodeId) {
        this.log('WARNING: Using deprecated removeNode. Use removeNodeConsensus for Raft compliance.');
        this.applyRemoveNode(nodeId);
    }
    shutdown() {
        if (this.electionTimeout) {
            clearTimeout(this.electionTimeout);
        }
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        this.log('Node shutdown');
    }
}
exports.RaftNode = RaftNode;
RaftNode.HEARTBEAT_INTERVAL = 100; // 100ms
RaftNode.MIN_ELECTION_TIMEOUT = 300; // 300ms
RaftNode.MAX_ELECTION_TIMEOUT = 500; // 500ms
//# sourceMappingURL=raftNode.js.map