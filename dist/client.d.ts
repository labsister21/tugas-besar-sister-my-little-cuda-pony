import { NodeInfo } from './types';
export declare class RaftClient {
    private clusterNodes;
    private currentLeader;
    constructor(clusterNodes: NodeInfo[]);
    private findLeader;
    private executeCommand;
    startCLI(): Promise<void>;
}
//# sourceMappingURL=client.d.ts.map