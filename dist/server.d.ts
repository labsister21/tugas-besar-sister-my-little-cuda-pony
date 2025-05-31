import { NodeInfo } from './types';
export declare class RaftServer {
    private app;
    private raftNode;
    constructor(nodeInfo: NodeInfo, clusterNodes: NodeInfo[]);
    private setupRoutes;
    start(): Promise<void>;
    shutdown(): void;
}
//# sourceMappingURL=server.d.ts.map