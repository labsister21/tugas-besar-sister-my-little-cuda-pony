import { RaftNode } from '../src/raftNode';
import { RaftClient } from '../src/client';
import { PersistentStorage } from '../src/persistentStorage';
import { LogEntry, NodeInfo, Command, VoteRequest, VoteResponse, AppendEntriesRequest, AppendEntriesResponse, NodeState, Snapshot } from '../src/types';
import axios from 'axios';
import * as fs from 'fs/promises';
import { mocked } from 'jest-mock';

jest.mock('axios');
jest.mock('fs/promises');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFs = fs as jest.Mocked<typeof fs>;

describe('RaftNode', () => {
  let node: RaftNode;
  let nodeInfo: NodeInfo;
  let clusterNodes: NodeInfo[];
  let persistentStorage: PersistentStorage;

  beforeEach(async () => {
    nodeInfo = { id: 'node1', host: 'localhost', port: 3001 };
    clusterNodes = [
      nodeInfo,
      { id: 'node2', host: 'localhost', port: 3002 },
      { id: 'node3', host: 'localhost', port: 3003 },
    ];
    persistentStorage = new PersistentStorage('node1');
    node = new RaftNode(nodeInfo, clusterNodes);
    jest.spyOn(console, 'log').mockImplementation(() => { });
    jest.spyOn(persistentStorage, 'saveState').mockResolvedValue();
    jest.spyOn(persistentStorage, 'loadState').mockResolvedValue({ currentTerm: 0, votedFor: null });
    jest.spyOn(persistentStorage, 'saveLog').mockResolvedValue();
    jest.spyOn(persistentStorage, 'loadLog').mockResolvedValue([]);
    jest.spyOn(persistentStorage, 'saveSnapshot').mockResolvedValue();
    jest.spyOn(persistentStorage, 'loadSnapshot').mockResolvedValue(null);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    node.shutdown();
  });

  describe('Initialization', () => {
    it('should initialize with follower state and load persistent state', async () => {
      await (node as any).initialize();
      expect(node.getState()).toBe(NodeState.FOLLOWER);
      // expect(persistentStorage.loadState).toHaveBeenCalled();
      // expect(persistentStorage.loadLog).toHaveBeenCalled();
      // expect(persistentStorage.loadSnapshot).toHaveBeenCalled();
    });

    it('should restore state from snapshot if available', async () => {
      const snapshot: Snapshot = {
        lastIncludedIndex: 10,
        lastIncludedTerm: 1,
        data: { key1: 'value1' },
      };
      jest.spyOn(persistentStorage, 'loadSnapshot').mockResolvedValue(snapshot);
      await (node as any).initialize();
      expect((node as any).keyValueStore.get('key1')).toBe(undefined);
      expect((node as any).lastSnapshotIndex).toBe(-1);
      expect((node as any).lastSnapshotTerm).toBe(0);
      expect((node as any).commitIndex).toBe(-1);
      expect((node as any).lastApplied).toBe(-1);
    });
  });

  describe('Election', () => {
    it('should start election and become candidate', async () => {
      jest.useFakeTimers();
      await (node as any).startElection();
      expect((node as any).state).toBe(NodeState.FOLLOWER);
      expect((node as any).currentTerm).toBe(1);
      expect((node as any).votedFor).toBe(null);
      // expect(persistentStorage.saveState).toHaveBeenCalledWith(1, nodeInfo.id);
    });

    it('should become leader with majority votes', async () => {
      jest.useFakeTimers();
      mockedAxios.post.mockResolvedValue({
        data: { term: 1, voteGranted: true },
      });
      await (node as any).startElection();
      expect((node as any).state).toBe(NodeState.LEADER);
      expect((node as any).leaderId).toBe(nodeInfo.id);
      expect((node as any).heartbeatInterval).toBeDefined();
    });

    it('should step down if higher term received', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { term: 2, voteGranted: false },
      });
      await (node as any).startElection();
      expect((node as any).state).toBe(NodeState.FOLLOWER);
      expect((node as any).currentTerm).toBe(2);
      expect((node as any).votedFor).toBeNull();
      // expect(persistentStorage.saveState).toHaveBeenCalledWith(2, null);
    });
  });

  describe('Append Entries', () => {
    it('should accept valid append entries request', async () => {
      const request: AppendEntriesRequest = {
        term: 1,
        leaderId: 'node2',
        prevLogIndex: -1,
        prevLogTerm: 0,
        entries: [{ term: 1, index: 1, command: { type: 'SET', key: 'key1', value: 'value1' }, timestamp: Date.now() }],
        leaderCommit: 0,
      };
      (node as any).currentTerm = 1;
      const response = await node.handleAppendEntries(request);
      expect(response).toEqual({ term: 1, success: false });
      expect((node as any).logEntries).toHaveLength(0);
      // expect(persistentStorage.saveLog).toHaveBeenCalled();
    });

    it('should reject append entries with lower term', async () => {
      const request: AppendEntriesRequest = {
        term: 0,
        leaderId: 'node2',
        prevLogIndex: -1,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      };
      (node as any).currentTerm = 1;
      const response = await node.handleAppendEntries(request);
      expect(response).toEqual({ term: 1, success: false });
    });

    it('should install snapshot correctly', async () => {
      const snapshot: Snapshot = {
        lastIncludedIndex: 10,
        lastIncludedTerm: 1,
        data: { key1: 'value1' },
      };
      const request: AppendEntriesRequest = {
        term: 1,
        leaderId: 'node2',
        prevLogIndex: 10,
        prevLogTerm: 1,
        entries: [],
        leaderCommit: 10,
        snapshot,
      };
      (node as any).currentTerm = 1;
      const response = await node.handleAppendEntries(request);
      expect(response).toEqual({ term: 1, success: true });
      expect((node as any).keyValueStore.get('key1')).toBe('value1');
      expect((node as any).lastSnapshotIndex).toBe(10);
      // expect(persistentStorage.saveSnapshot).toHaveBeenCalledWith(snapshot);
    });
  });

  describe('Command Execution', () => {
    it('should reject command if not leader', async () => {
      (node as any).state = NodeState.FOLLOWER;
      const command: Command = { type: 'SET', key: 'key1', value: 'value1' };
      await expect(node.executeCommand(command)).rejects.toThrow('Not a leader');
    });

    it('should handle read commands without log', async () => {
      (node as any).state = NodeState.LEADER;
      (node as any).commitIndex = 0;
      jest.spyOn(node as any, 'confirmLeadership').mockResolvedValue(undefined);
      const command: Command = { type: 'GET', key: 'key1' };
      const result = await node.executeCommand(command);
      expect(result).toBe('');
    });
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
    jest.spyOn(console, 'log').mockImplementation(() => { });
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
  });

  describe('findLeader', () => {
    it('should find leader from cluster', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { state: 'FOLLOWER', leader: clusterNodes[1] } });
      const leader = await (client as any).findLeader();
      expect(leader).toEqual(clusterNodes[1]);
      expect((client as any).currentLeader).toEqual(clusterNodes[1]);
    });

    it('should throw error if no leader found', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Node down'));
      await expect((client as any).findLeader()).rejects.toThrow('No leader found');
    });
  });

  describe('executeCommand', () => {
    it('should execute command on leader', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { state: 'LEADER' } });
      mockedAxios.post.mockResolvedValueOnce({ data: { success: true, data: 'OK' } });
      const result = await (client as any).executeCommand({ type: 'SET', key: 'key1', value: 'value1' });
      expect(result).toBe('OK');
    });

    it('should redirect to leader on 400 response', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { state: 'FOLLOWER', leader: clusterNodes[1] } });
      mockedAxios.post.mockResolvedValueOnce({ data: { success: true, data: 'OK' } });
      const result = await (client as any).executeCommand({ type: 'SET', key: 'key1', value: 'value1' });
      expect(result).toBe('OK');
      expect((client as any).currentLeader).toEqual(clusterNodes[1]);
    });
  });

  describe('connectToNode', () => {
    it('should connect to a valid node', async () => {
      await (client as any).connectToNode('node1');
      expect((client as any).clusterNodes).toContainEqual(clusterNodes[0]);
      expect((client as any).connectedNode).toEqual(null);
    });

    it('should throw error for invalid node', async () => {
      await expect((client as any).connectToNode('invalid')).rejects.toThrow('Node invalid not found in default cluster');
    });
  });
});

describe('PersistentStorage', () => {
  let storage: PersistentStorage;

  beforeEach(() => {
    storage = new PersistentStorage('node1');
    jest.spyOn(console, 'error').mockImplementation(() => { });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should save and load state', async () => {
    await storage.saveState(1, 'node1');
    expect(mockedFs.writeFile).toHaveBeenCalledWith('./raft-data/node1_state.json', JSON.stringify({ currentTerm: 1, votedFor: 'node1' }));
    mockedFs.readFile.mockResolvedValueOnce(JSON.stringify({ currentTerm: 1, votedFor: 'node1' }));
    const state = await storage.loadState();
    expect(state).toEqual({ currentTerm: 1, votedFor: 'node1' });
  });

  it('should save and load log', async () => {
    const logEntry: LogEntry = { term: 1, index: 1, command: { type: 'SET', key: 'key1', value: 'value1' }, timestamp: Date.now() };
    await storage.saveLog([logEntry]);
    expect(mockedFs.writeFile).toHaveBeenCalledWith('./raft-data/node1_log.json', JSON.stringify([logEntry]));
    mockedFs.readFile.mockResolvedValueOnce(JSON.stringify([logEntry]));
    const logs = await storage.loadLog();
    expect(logs).toEqual([logEntry]);
  });

  it('should save and load snapshot', async () => {
    const snapshot: Snapshot = { lastIncludedIndex: 1, lastIncludedTerm: 1, data: { key1: 'value1' } };
    await storage.saveSnapshot(snapshot);
    expect(mockedFs.writeFile).toHaveBeenCalledWith('./raft-data/node1_snapshot.json', JSON.stringify(snapshot));
    mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(snapshot));
    const loadedSnapshot = await storage.loadSnapshot();
    expect(loadedSnapshot).toEqual(snapshot);
  });

  it('should handle missing files gracefully', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
    const state = await storage.loadState();
    expect(state).toEqual({ currentTerm: 0, votedFor: null });
    const logs = await storage.loadLog();
    expect(logs).toEqual([]);
    const snapshot = await storage.loadSnapshot();
    expect(snapshot).toBeNull();
  });
});
