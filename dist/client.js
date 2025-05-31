"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RaftClient = void 0;
const axios_1 = __importDefault(require("axios"));
const readline_1 = __importDefault(require("readline"));
class RaftClient {
    constructor(clusterNodes) {
        this.currentLeader = null;
        this.clusterNodes = clusterNodes;
    }
    async findLeader() {
        if (this.currentLeader) {
            try {
                const response = await axios_1.default.get(`http://${this.currentLeader.host}:${this.currentLeader.port}/health`);
                if (response.data.state === 'LEADER') {
                    return this.currentLeader;
                }
            }
            catch (error) {
                // Leader might be down
            }
        }
        // Try to find leader
        for (const node of this.clusterNodes) {
            try {
                const response = await axios_1.default.get(`http://${node.host}:${node.port}/health`);
                if (response.data.state === 'LEADER') {
                    this.currentLeader = node;
                    return node;
                }
                else if (response.data.leader) {
                    this.currentLeader = response.data.leader;
                    return response.data.leader;
                }
            }
            catch (error) {
                // Node is down
            }
        }
        throw new Error('No leader found');
    }
    async executeCommand(command) {
        try {
            const leader = await this.findLeader();
            const response = await axios_1.default.post(`http://${leader.host}:${leader.port}/execute`, { command });
            if (response.status === 302) {
                // Redirect to leader
                if (response.data.leaderInfo) {
                    this.currentLeader = response.data.leaderInfo;
                    return this.executeCommand(command);
                }
                throw new Error('No leader available');
            }
            if (!response.data.success) {
                throw new Error(response.data.error || 'Command failed');
            }
            return response.data.data;
        }
        catch (error) {
            if (axios_1.default.isAxiosError(error) && error.response?.status === 302) {
                const leaderInfo = error.response.data.leaderInfo;
                if (leaderInfo) {
                    this.currentLeader = leaderInfo;
                    return this.executeCommand(command);
                }
            }
            throw error;
        }
    }
    async startCLI() {
        const rl = readline_1.default.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        console.log('Raft KV Store Client');
        console.log('Available commands: ping, get <key>, set <key> <value>, strln <key>, del <key>, append <key> <value>');
        console.log('Type "exit" to quit');
        const promptUser = () => {
            rl.question('> ', async (input) => {
                const parts = input.trim().split(' ');
                const commandType = parts[0].toLowerCase();
                try {
                    switch (commandType) {
                        case 'exit':
                            rl.close();
                            return;
                        case 'ping':
                            const pongResult = await this.executeCommand({ type: 'PING' });
                            console.log(pongResult);
                            break;
                        case 'get':
                            if (parts.length < 2) {
                                console.log('Usage: get <key>');
                                break;
                            }
                            const getValue = await this.executeCommand({ type: 'GET', key: parts[1] });
                            console.log(`"${getValue}"`);
                            break;
                        case 'set':
                            if (parts.length < 3) {
                                console.log('Usage: set <key> <value>');
                                break;
                            }
                            const setValue = parts.slice(2).join(' ');
                            await this.executeCommand({ type: 'SET', key: parts[1], value: setValue });
                            console.log('OK');
                            break;
                        case 'strln':
                            if (parts.length < 2) {
                                console.log('Usage: strln <key>');
                                break;
                            }
                            const length = await this.executeCommand({ type: 'STRLN', key: parts[1] });
                            console.log(length);
                            break;
                        case 'del':
                            if (parts.length < 2) {
                                console.log('Usage: del <key>');
                                break;
                            }
                            const delValue = await this.executeCommand({ type: 'DEL', key: parts[1] });
                            console.log(`"${delValue}"`);
                            break;
                        case 'append':
                            if (parts.length < 3) {
                                console.log('Usage: append <key> <value>');
                                break;
                            }
                            const appendValue = parts.slice(2).join(' ');
                            await this.executeCommand({ type: 'APPEND', key: parts[1], value: appendValue });
                            console.log('OK');
                            break;
                        default:
                            console.log('Unknown command');
                    }
                }
                catch (error) {
                    console.log(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
                promptUser();
            });
        };
        promptUser();
    }
}
exports.RaftClient = RaftClient;
//# sourceMappingURL=client.js.map