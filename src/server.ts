import express, { Request, Response, NextFunction } from 'express';
import { RaftNode } from './raftNode';
import { NodeInfo, Command, ClientRequest, ClientResponse } from './types';

// Helper function to wrap async route handlers
const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export class RaftServer {
  private app: express.Application;
  private raftNode: RaftNode;

  constructor(nodeInfo: NodeInfo, clusterNodes: NodeInfo[]) {
    this.app = express();
    this.app.use(express.json());
    this.raftNode = new RaftNode(nodeInfo, clusterNodes);
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Raft internal endpoints
    this.app.post('/raft/vote', (req: Request, res: Response) => {
      const response = this.raftNode.handleVoteRequest(req.body);
      res.json(response);
    });

    this.app.post('/raft/append', (req: Request, res: Response) => {
      const response = this.raftNode.handleAppendEntries(req.body);
      res.json(response);
    });

    // Client endpoints
    this.app.post('/execute', asyncHandler(async (req: Request, res: Response) => {
      if (this.raftNode.getState() !== 'LEADER') {
        const leaderInfo = this.raftNode.getLeaderInfo();
        res.status(400).json({
          success: false,
          error: 'Not a leader',
          leaderInfo,
          code: 'NOT_LEADER'
        } as ClientResponse);
        return;
      }

      const { command } = req.body as ClientRequest;
      const result = await this.raftNode.executeCommand(command);
      
      res.json({
        success: true,
        data: result
      } as ClientResponse);
    }));

    this.app.get('/request_log', (req: Request, res: Response) => {
      if (this.raftNode.getState() !== 'LEADER') {
        const leaderInfo = this.raftNode.getLeaderInfo();
        res.status(400).json({
          success: false,
          error: 'Not a leader',
          leaderInfo
        });
        return;
      }

      res.json({
        success: true,
        data: this.raftNode.getLog()
      });
    });

    // Membership management
    this.app.post('/cluster/add', asyncHandler(async (req: Request, res: Response) => {
      if (this.raftNode.getState() !== 'LEADER') {
        const leaderInfo = this.raftNode.getLeaderInfo();
        res.status(400).json({
          success: false,
          error: 'Not a leader',
          leaderInfo
        });
        return;
      }

      const { nodeInfo } = req.body as { nodeInfo: NodeInfo };
      // Use consensus-based membership change
      await this.raftNode.addNodeConsensus(nodeInfo);
      
      res.json({ success: true });
    }));

    this.app.delete('/cluster/remove/:nodeId', asyncHandler(async (req: Request, res: Response) => {
      if (this.raftNode.getState() !== 'LEADER') {
        const leaderInfo = this.raftNode.getLeaderInfo();
        res.status(400).json({
          success: false,
          error: 'Not a leader',
          leaderInfo
        });
        return;
      }

      const { nodeId } = req.params;
      // Use consensus-based membership change
      await this.raftNode.removeNodeConsensus(nodeId);
      
      res.json({ success: true });
    }));

    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        state: this.raftNode.getState(),
        leader: this.raftNode.getLeaderInfo()
      });
    });

    // Error handling middleware
    this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
      console.error('Server error:', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Internal server error'
      });
    });
  }

  public start(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.app.listen(this.raftNode['nodeInfo'].port, () => {
        console.log(`Raft server listening on port ${this.raftNode['nodeInfo'].port}`);
        resolve();
      });
    });
  }

  public shutdown(): void {
    this.raftNode.shutdown();
  }
}