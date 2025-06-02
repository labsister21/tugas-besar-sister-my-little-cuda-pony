import { RaftNode } from '../src/raftNode';
import { RaftClient } from '../src/client';
import { RaftServer } from '../src/server';
import { NodeInfo, NodeState, Command, VoteRequest, AppendEntriesRequest, LogEntry } from '../src/types';
import axios from 'axios';
import { EventEmitter } from 'events';
import request from 'supertest';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('RaftNode', () => {
  let node: RaftNode;
  let clusterNodes: NodeInfo[];
  const nodeInfo: NodeInfo = { id: 'node1', host: 'localhost', port: 3001 };

  beforeEach(() => {
    clusterNodes = [
      { id: 'node1', host: 'localhost', port: 3001 },
      { id: 'node2', host: 'localhost', port: 3002 },
      { id: 'node3', host: 'localhost', port: 3003 },
    ];
    node = new RaftNode(nodeInfo, clusterNodes);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.clearAllMocks();
  });

  test('should start election after timeout', async () => {
    (node as any).resetElectionTimeout();
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    expect(node.getState()).toBe(NodeState.CANDIDATE);
  });

  test('should grant vote for valid vote request', () => {
    const voteRequest: VoteRequest = {
      term: 1,
      candidateId: 'node2',
      lastLogIndex: 0,
      lastLogTerm: 0,
    };
    const response = node.handleVoteRequest(voteRequest);
    expect(response).toEqual({ term: 1, voteGranted: true });
    expect((node as any).votedFor).toBe('node2');
  });

  test('should deny vote if already voted', () => {
    (node as any).votedFor = 'node3';
    (node as any).currentTerm = 1;
    const voteRequest: VoteRequest = {
      term: 1,
      candidateId: 'node2',
      lastLogIndex: 0,
      lastLogTerm: 0,
    };
    const response = node.handleVoteRequest(voteRequest);
    expect(response).toEqual({ term: 1, voteGranted: false });
  });

  test('should append entries and update commit index', () => {
    const appendRequest: AppendEntriesRequest = {
      term: 1,
      leaderId: 'node2',
      prevLogIndex: -1,
      prevLogTerm: 0,
      entries: [
        { term: 1, index: 0, command: { type: 'SET', key: 'key', value: 'value' }, timestamp: Date.now() },
      ],
      leaderCommit: 0,
    };
    const response = node.handleAppendEntries(appendRequest);
    expect(response).toEqual({ term: 1, success: true });
    expect((node as any).logEntries).toHaveLength(1);
    expect((node as any).commitIndex).toBe(0);
  });

  test('should throw error when executing command as non-leader', async () => {
    (node as any).state = NodeState.FOLLOWER;
    const command: Command = { type: 'SET', key: 'key', value: 'value' };
    await expect(node.executeCommand(command)).rejects.toThrow('Not a leader');
  });
});

describe('RaftClient', () => {
  let client: RaftClient;
  let clusterNodes: NodeInfo[];

  beforeEach(() => {
    clusterNodes = [
      { id: 'node1', host: 'localhost', port: 3001 },
      { id: 'node2', host: 'localhost', port: 3002 },
    ];
    client = new RaftClient(clusterNodes);
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
  });

  test('should find leader from health endpoint', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { state: 'LEADER' },
    });
    const leader = await (client as any).findLeader();
    expect(leader).toEqual(clusterNodes[0]);
    expect(mockedAxios.get).toHaveBeenCalledWith('http://localhost:3001/health');
  });

  test('should execute command successfully', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { state: 'LEADER' },
    });
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data: 'OK' },
    });
    const result = await (client as any).executeCommand({ type: 'PING' });
    expect(result).toBe('OK');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:3001/execute',
      { command: { type: 'PING' } }
    );
  });

  test('should handle redirect to new leader', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { state: 'FOLLOWER', leader: clusterNodes[1] },
    });
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data: 'OK' },
    });
    const result = await (client as any).executeCommand({ type: 'PING' });
    expect(result).toBe('OK');
    expect((client as any).currentLeader).toEqual(clusterNodes[1]);
  });
});

describe('RaftServer', () => {
  let server: RaftServer;
  let clusterNodes: NodeInfo[];
  const nodeInfo: NodeInfo = { id: 'node1', host: 'localhost', port: 3001 };

  beforeEach(() => {
    clusterNodes = [
      { id: 'node1', host: 'localhost', port: 3001 },
      { id: 'node2', host: 'localhost', port: 3002 },
    ];
    server = new RaftServer(nodeInfo, clusterNodes);
  });

  test('should handle execute command when leader', async () => {
    jest.spyOn((server as any).raftNode, 'getState').mockReturnValue(NodeState.LEADER);
    jest.spyOn((server as any).raftNode, 'executeCommand').mockResolvedValue('OK');
    const response = await request((server as any).app)
      .post('/execute')
      .send({ command: { type: 'SET', key: 'key', value: 'value' } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: 'OK' });
    expect((server as any).raftNode.executeCommand).toHaveBeenCalledWith({
      type: 'SET',
      key: 'key',
      value: 'value',
    });
  });

  test('should reject execute command when not leader', async () => {
    jest.spyOn((server as any).raftNode, 'getState').mockReturnValue(NodeState.FOLLOWER);
    const leaderInfo = clusterNodes[1];
    jest.spyOn((server as any).raftNode, 'getLeaderInfo').mockReturnValue(leaderInfo);
    const response = await request((server as any).app)
      .post('/execute')
      .send({ command: { type: 'SET', key: 'key', value: 'value' } });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'Not a leader',
      leaderInfo,
      code: 'NOT_LEADER',
    });
  });
});
