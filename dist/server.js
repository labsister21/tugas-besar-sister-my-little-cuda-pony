"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RaftServer = void 0;
const express_1 = __importDefault(require("express"));
const raftNode_1 = require("./raftNode");
// Helper function to wrap async route handlers
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};
class RaftServer {
    constructor(nodeInfo, clusterNodes) {
        this.app = (0, express_1.default)();
        this.app.use(express_1.default.json());
        this.raftNode = new raftNode_1.RaftNode(nodeInfo, clusterNodes);
        this.setupRoutes();
    }
    setupRoutes() {
        // Raft internal endpoints
        this.app.post('/raft/vote', (req, res) => {
            const response = this.raftNode.handleVoteRequest(req.body);
            res.json(response);
        });
        this.app.post('/raft/append', (req, res) => {
            const response = this.raftNode.handleAppendEntries(req.body);
            res.json(response);
        });
        // Client endpoints
        this.app.post('/execute', asyncHandler(async (req, res) => {
            if (this.raftNode.getState() !== 'LEADER') {
                const leaderInfo = this.raftNode.getLeaderInfo();
                res.status(400).json({
                    success: false,
                    error: 'Not a leader',
                    leaderInfo,
                    code: 'NOT_LEADER'
                });
                return;
            }
            const { command } = req.body;
            const result = await this.raftNode.executeCommand(command);
            res.json({
                success: true,
                data: result
            });
        }));
        this.app.get('/request_log', (req, res) => {
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
        this.app.post('/cluster/add', asyncHandler(async (req, res) => {
            if (this.raftNode.getState() !== 'LEADER') {
                const leaderInfo = this.raftNode.getLeaderInfo();
                res.status(400).json({
                    success: false,
                    error: 'Not a leader',
                    leaderInfo
                });
                return;
            }
            const { nodeInfo } = req.body;
            // Use consensus-based membership change
            await this.raftNode.addNodeConsensus(nodeInfo);
            res.json({ success: true });
        }));
        this.app.delete('/cluster/remove/:nodeId', asyncHandler(async (req, res) => {
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
        this.app.get('/health', (req, res) => {
            res.json({
                state: this.raftNode.getState(),
                leader: this.raftNode.getLeaderInfo()
            });
        });
        // Error handling middleware
        this.app.use((err, req, res, next) => {
            console.error('Server error:', err);
            res.status(500).json({
                success: false,
                error: err.message || 'Internal server error'
            });
        });
    }
    start() {
        return new Promise((resolve) => {
            const server = this.app.listen(this.raftNode['nodeInfo'].port, () => {
                console.log(`Raft server listening on port ${this.raftNode['nodeInfo'].port}`);
                resolve();
            });
        });
    }
    shutdown() {
        this.raftNode.shutdown();
    }
}
exports.RaftServer = RaftServer;
//# sourceMappingURL=server.js.map