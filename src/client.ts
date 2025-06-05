import axios from "axios";
import readline from "readline";
import { NodeInfo, Command, ClientResponse, LogEntry } from "./types";
import { DEFAULT_CLUSTER } from "./clusterConfig";

export class RaftClient {
  private clusterNodes: NodeInfo[];
  private currentLeader: NodeInfo | null = null;
  private connectedNode: NodeInfo | null = null;

  constructor(clusterNodes: NodeInfo[] = []) {
    this.clusterNodes = clusterNodes;
  }

  private async findLeader(): Promise<NodeInfo> {
    if (this.currentLeader) {
      try {
        const response = await axios.get(
          `http://${this.currentLeader.host}:${this.currentLeader.port}/health`
        );
        if (response.data.state === "LEADER") {
          return this.currentLeader;
        }
      } catch (error) {
        console.log(
          `Current leader ${this.currentLeader.id} is down, searching for a new leader...`
        );
      }
    }

    // Try to find leader
    for (const node of this.clusterNodes) {
      try {
        const response = await axios.get(
          `http://${node.host}:${node.port}/health`
        );
        if (response.data.state === "LEADER") {
          this.currentLeader = node;
          return node;
        } else if (response.data.leader) {
          this.currentLeader = response.data.leader;
          return response.data.leader;
        }
      } catch (error) {
        console.log(
          `Node ${node.id} is down or not a leader, trying next node...`
        );
      }
    }

    throw new Error("No leader found");
  }

  private async executeCommand(
    command: Command,
    targetNodeId?: string
  ): Promise<any> {
    try {
      let targetNode: NodeInfo;

      if (targetNodeId) {
        const node = this.clusterNodes.find((n) => n.id === targetNodeId);
        if (!node) {
          throw new Error(`Node ${targetNodeId} not found in cluster`);
        }
        targetNode = node;
      } else {
        targetNode = await this.findLeader();
      }

      const response = await axios.post<ClientResponse>(
        `http://${targetNode.host}:${targetNode.port}/execute`,
        { command }
      );

      if (
        response.status === 302 ||
        (response.status === 400 && response.data.leaderInfo)
      ) {
        // redirect to leader
        if (response.data.leaderInfo) {
          this.currentLeader = response.data.leaderInfo;
          return this.executeCommand(command);
        }
        throw new Error("No leader available");
      }

      if (!response.data.success) {
        throw new Error(response.data.error || "Command failed");
      }

      return response.data.data;
    } catch (error) {
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 302 || error.response?.status === 400)
      ) {
        const leaderInfo = error.response.data.leaderInfo;
        if (leaderInfo) {
          this.currentLeader = leaderInfo;
          return this.executeCommand(command);
        }
      }
      throw error;
    }
  }

  private async connectToNode(nodeId: string): Promise<void> {
    const node = DEFAULT_CLUSTER.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found in default cluster`);
    }
    if (!this.clusterNodes.some((n) => n.id === nodeId)) {
      this.clusterNodes.push(node);
      this.connectedNode = node;
      console.log(`Connected to node ${nodeId}`);
    } else {
      console.log(`Already connected to node ${nodeId}`);
    }
  }

  private async disconnectFromNode(nodeId: string): Promise<void> {
    const nodeIndex = this.clusterNodes.findIndex((n) => n.id === nodeId);
    if (nodeIndex === -1) {
      throw new Error(`Not connected to node ${nodeId}`);
    }
    this.clusterNodes.splice(nodeIndex, 1);
    if (this.connectedNode?.id === nodeId) {
      this.connectedNode = null;
    }
    console.log(`Disconnected from node ${nodeId}`);
  }

  public async startCLI(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log("Raft KV Store Client");
    console.log(
      "Available commands: connect <nodeId>, disconnect <nodeId>, [<nodeId>] ping, [<nodeId>] get <key>, [<nodeId>] set <key> <value>, [<nodeId>] strln <key>, [<nodeId>] del <key>, [<nodeId>] append <key> <value>, request_log, add_node <nodeId>, remove_node <nodeId>"
    );
    console.log('Type "exit" to quit');

    const promptUser = () => {
      rl.question("> ", async (input) => {
        const parts = input.trim().split(" ");
        let targetNodeId: string | undefined;
        let commandType: string;
        let commandParts: string[];

        // Check if first argument is a nodeId
        if (DEFAULT_CLUSTER.some((node) => node.id === parts[0])) {
          targetNodeId = parts[0];
          commandType = parts[1]?.toLowerCase() || "";
          commandParts = parts.slice(2);
        } else {
          commandType = parts[0]?.toLowerCase() || "";
          commandParts = parts.slice(1);
        }

        try {
          switch (commandType) {
            case "exit":
              rl.close();
              return;

            case "connect":
              if (commandParts.length < 1) {
                console.log("Usage: connect <nodeId>");
                break;
              }
              await this.connectToNode(commandParts[0]);
              break;

            case "disconnect":
              if (commandParts.length < 1) {
                console.log("Usage: disconnect <nodeId>");
                break;
              }
              await this.disconnectFromNode(commandParts[0]);
              break;

            case "add_node":
              if (commandParts.length < 1) {
                console.log("Usage: add_node <nodeId>");
                break;
              }
              const nodeToAdd = DEFAULT_CLUSTER.find(
                (n) => n.id === commandParts[0]
              );
              if (!nodeToAdd) {
                console.log(
                  `Node ${commandParts[0]} not found in default cluster`
                );
                break;
              }
              await this.executeCommand(
                { type: "ADD_NODE", nodeInfo: nodeToAdd },
                targetNodeId
              );
              console.log(`Node ${commandParts[0]} added to cluster`);
              break;

            case "remove_node":
              if (commandParts.length < 1) {
                console.log("Usage: remove_node <nodeId>");
                break;
              }
              await this.executeCommand(
                { type: "REMOVE_NODE", nodeId: commandParts[0] },
                targetNodeId
              );
              console.log(`Node ${commandParts[0]} removed from cluster`);
              break;

            case "ping":
              if (this.clusterNodes.length === 0) {
                console.log(
                  "Not connected to any node. Use 'connect <nodeId>' first."
                );
                break;
              }
              const pongResult = await this.executeCommand(
                { type: "PING" },
                targetNodeId
              );
              console.log(pongResult);
              break;

            case "get":
              if (this.clusterNodes.length === 0) {
                console.log(
                  "Not connected to any node. Use 'connect <nodeId>' first."
                );
                break;
              }
              if (commandParts.length < 1) {
                console.log("Usage: [<nodeId>] get <key>");
                break;
              }
              const getValue = await this.executeCommand(
                { type: "GET", key: commandParts[0] },
                targetNodeId
              );
              console.log(`"${getValue}"`);
              break;

            case "set":
              if (this.clusterNodes.length === 0) {
                console.log(
                  "Not connected to any node. Use 'connect <nodeId>' first."
                );
                break;
              }
              if (commandParts.length < 2) {
                console.log("Usage: [<nodeId>] set <key> <value>");
                break;
              }
              const setValue = commandParts.slice(1).join(" ");
              await this.executeCommand(
                { type: "SET", key: commandParts[0], value: setValue },
                targetNodeId
              );
              console.log("OK");
              break;

            case "strln":
              if (this.clusterNodes.length === 0) {
                console.log(
                  "Not connected to any node. Use 'connect <nodeId>' first."
                );
                break;
              }
              if (commandParts.length < 1) {
                console.log("Usage: [<nodeId>] strln <key>");
                break;
              }
              const length = await this.executeCommand(
                { type: "STRLN", key: commandParts[0] },
                targetNodeId
              );
              console.log(length);
              break;

            case "del":
              if (this.clusterNodes.length === 0) {
                console.log(
                  "Not connected to any node. Use 'connect <nodeId>' first."
                );
                break;
              }
              if (commandParts.length < 1) {
                console.log("Usage: [<nodeId>] del <key>");
                break;
              }
              const delValue = await this.executeCommand(
                { type: "DEL", key: commandParts[0] },
                targetNodeId
              );
              console.log(`"${delValue}"`);
              break;

            case "append":
              if (this.clusterNodes.length === 0) {
                console.log(
                  "Not connected to any node. Use 'connect <nodeId>' first."
                );
                break;
              }
              if (commandParts.length < 2) {
                console.log("Usage: [<nodeId>] append <key> <value>");
                break;
              }
              const appendValue = commandParts.slice(1).join(" ");
              await this.executeCommand(
                { type: "APPEND", key: commandParts[0], value: appendValue },
                targetNodeId
              );
              console.log("OK");
              break;

            case "request_log":
              if (this.clusterNodes.length === 0) {
                console.log(
                  "Not connected to any node. Use 'connect <nodeId>' first."
                );
                break;
              }
              const logs = await this.executeCommand(
                { type: "REQUEST_LOG" },
                targetNodeId
              );
              console.log("Logs from leader:");
              logs.forEach((log: LogEntry, index: number) => {
                console.log(
                  `[${index}] Term: ${log.term}, Command: ${JSON.stringify(
                    log.command
                  )}, Timestamp: ${new Date(log.timestamp).toISOString()}`
                );
              });
              break;

            default:
              console.log("Unknown command");
          }
        } catch (error) {
          console.log(
            `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }

        promptUser();
      });
    };

    promptUser();
  }
}
