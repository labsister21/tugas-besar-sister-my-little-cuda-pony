import { RaftServer } from './server';
import { RaftClient } from './client';
import { NodeInfo } from './types';
import { DEFAULT_CLUSTER } from './clusterConfig';

async function startServer(nodeId: string, port: number, host: string): Promise<void> {
  const nodeInfo = DEFAULT_CLUSTER.find(node => node.id === nodeId);
  if (!nodeInfo) {
    console.error(`Node ${nodeId} not found in cluster configuration`);
    process.exit(1);
  }

  nodeInfo.port = parseInt(process.env.NODE_PORT || port.toString(), 10);
  nodeInfo.host = process.env.NODE_HOST || host;

  const server = new RaftServer(nodeInfo, DEFAULT_CLUSTER);
  await server.start();

  process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    server.shutdown();
    process.exit(0);
  });
}

async function startClient(): Promise<void> {
  const client = new RaftClient();
  await client.startCLI();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  Start server: npm run dev server <nodeId>');
    console.log('  Start client: npm run dev client');
    console.log('');
    console.log('Example:');
    console.log('  npm run dev server node1');
    console.log('  npm run dev server node2');
    console.log('  npm run dev server node3');
    console.log('  npm run dev client');
    return;
  }

  const mode = args[0];

  if (mode === 'server') {
    if (args.length < 2) {
      console.log('Please specify node ID (node1, node2, or node3)');
      return;
    }
    
    const nodeId = args[1];
    const nodeInfo = DEFAULT_CLUSTER.find(node => node.id === nodeId);
    if (!nodeInfo) {
      console.log('Invalid node ID. Use node1, node2, or node3');
      return;
    }

    await startServer(nodeId, nodeInfo.port, nodeInfo.host);
  } else if (mode === 'client') {
    await startClient();
  } else {
    console.log('Invalid mode. Use "server" or "client"');
  }
}

if (require.main === module) {
  main().catch(console.error);
}
