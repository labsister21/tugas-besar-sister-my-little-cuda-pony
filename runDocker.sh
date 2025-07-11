#!/bin/bash

# Check if correct number of arguments is provided
if [ "$#" -ne 2 ]; then
    echo "Usage: ./runDocker.sh <jumlah_server> <jumlah_client>"
    exit 1
fi

jumlah_server=$1
jumlah_client=$2

# Validate inputs
if ! [[ "$jumlah_server" =~ ^[0-9]+$ ]] || [ "$jumlah_server" -lt 1 ]; then
    echo "Error: jumlah_server must be a positive integer"
    exit 1
fi
if ! [[ "$jumlah_client" =~ ^[0-9]+$ ]] || [ "$jumlah_client" -lt 0 ]; then
    echo "Error: jumlah_client must be a non-negative integer"
    exit 1
fi

# Create docker-compose.yml
cat << EOF > docker-compose.yml
version: '3.8'

services:
EOF

# Generate server nodes
for ((i=1; i<=jumlah_server; i++)); do
    node_id="node$i"
    port=$((3000 + i))
    cat << EOF >> docker-compose.yml
  raft-server-$i:
    build: .
    container_name: raft-server-$i
    cap_add:
      - NET_ADMIN
    environment:
      - NODE_ID=$node_id
      - NODE_PORT=$port
      - NODE_HOST=raft-server-$i
    ports:
      - "$port:$port"
    networks:
      - raft-network
    command: npm run dev server $node_id
EOF
done

# Generate client nodes
for ((i=1; i<=jumlah_client; i++)); do
    cat << EOF >> docker-compose.yml
  raft-client-$i:
    build: .
    container_name: raft-client-$i
    tty: true
    stdin_open: true
    networks:
      - raft-network
    command: sleep infinity
EOF
done

# Define the network
cat << EOF >> docker-compose.yml
networks:
  raft-network:
    driver: bridge
EOF

# Generate cluster configuration for servers
cluster_config="export const DEFAULT_CLUSTER = ["
for ((i=1; i<=jumlah_server; i++)); do
    port=$((3000 + i))
    cluster_config+="{\"id\": \"node$i\", \"host\": \"raft-server-$i\", \"port\": $port}"
    if [ $i -lt $jumlah_server ]; then
        cluster_config+=", "
    fi
done
cluster_config+="];"

# Write cluster configuration to clusterConfig.ts
echo $cluster_config > src/clusterConfig.ts

# Start Docker Compose in detached mode
echo "Starting $jumlah_server server(s) and $jumlah_client client(s)..."
docker-compose up --build -d

echo "All servers are running and connected to each other."
echo "Clients are available but not connected. To connect a client, use:"
echo "  docker exec -it raft-client-<number> npm run dev client"
echo "To stop all containers, run: docker-compose down"
