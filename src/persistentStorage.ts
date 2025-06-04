import * as fs from 'fs/promises';
import { LogEntry, NodeInfo, Snapshot } from './types';

export class PersistentStorage {
  private stateFile: string;
  private logFile: string;
  private snapshotFile: string;

  constructor(nodeId: string) {
    this.stateFile = `./raft-data/${nodeId}_state.json`;
    this.logFile = `./raft-data/${nodeId}_log.json`;
    this.snapshotFile = `./raft-data/${nodeId}_snapshot.json`;
  }

  async init(): Promise<void> {
    await fs.mkdir('./raft-data', { recursive: true });
  }

  async saveState(currentTerm: number, votedFor: string | null): Promise<void> {
    const state = { currentTerm, votedFor };
    await fs.writeFile(this.stateFile, JSON.stringify(state));
  }

  async loadState(): Promise<{ currentTerm: number; votedFor: string | null }> {
    try {
      const data = await fs.readFile(this.stateFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return { currentTerm: 0, votedFor: null };
    }
  }

  async saveLog(logEntries: LogEntry[]): Promise<void> {
    await fs.writeFile(this.logFile, JSON.stringify(logEntries));
  }

  async loadLog(): Promise<LogEntry[]> {
    try {
      const data = await fs.readFile(this.logFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return [];
    }
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    await fs.writeFile(this.snapshotFile, JSON.stringify(snapshot));
  }

  async loadSnapshot(): Promise<Snapshot | null> {
    try {
      const data = await fs.readFile(this.snapshotFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  async clearSnapshot(): Promise<void> {
    try {
      await fs.unlink(this.snapshotFile);
    } catch (error) {
      // Ignore if file doesn't exist
    }
  }
}
