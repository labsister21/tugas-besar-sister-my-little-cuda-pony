export interface NodeInfo {
  id: string;
  host: string;
  port: number;
}

export interface LogEntry {
  term: number;
  index: number;
  command: Command;
  timestamp: number;
}

export interface Snapshot {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  data: { [key: string]: string };
}

export interface Command {
  type: 'SET' | 'DEL' | 'APPEND' | 'PING' | 'GET' | 'STRLN' | 'ADD_NODE' | 'REMOVE_NODE' | 'REQUEST_LOG';
  key?: string;
  value?: string;
  nodeInfo?: NodeInfo;
  nodeId?: string;
}

export interface MembershipChangeCommand {
  type: 'ADD_NODE' | 'REMOVE_NODE';
  nodeInfo?: NodeInfo;
  nodeId?: string;
}

export interface VoteRequest {
  term: number;
  candidateId: string;
  lastLogIndex: number;
  lastLogTerm: number;
}

export interface VoteResponse {
  term: number;
  voteGranted: boolean;
}

export interface AppendEntriesRequest {
  term: number;
  leaderId: string;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry[];
  leaderCommit: number;
  snapshot?: Snapshot;
}

export interface AppendEntriesResponse {
  term: number;
  success: boolean;
}

export enum NodeState {
  FOLLOWER = 'FOLLOWER',
  CANDIDATE = 'CANDIDATE',
  LEADER = 'LEADER'
}

export interface ClientRequest {
  command: Command;
  clientId: string;
  requestId: string;
}

export interface ClientResponse {
  success: boolean;
  data?: any;
  error?: string;
  leaderInfo?: NodeInfo;
}
