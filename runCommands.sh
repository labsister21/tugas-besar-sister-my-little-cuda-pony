#!/bin/bash

# Check if Docker containers for clients are running
if ! docker ps | grep -q "raft-client-1"; then
    echo "Error: raft-client-1 is not running. Please run './runDocker.sh 4 2' first."
    exit 1
fi

if ! docker ps | grep -q "raft-client-2"; then
    echo "Error: raft-client-2 is not running. Please run './runDocker.sh 4 2' first."
    exit 1
fi

# Commands for client 1
CLIENT1_COMMANDS=(
    "SET ruby-chan choco-minto"
    "APPEND ruby-chan -yori-mo-anata"
)

# Commands for client 2
CLIENT2_COMMANDS=(
    "SET ayumu-chan strawberry-flavor"
    "APPEND ayumu-chan -yori-mo-anata"
)

# Function to send commands to a client
send_commands() {
    local container=$1
    shift
    local commands=("$@")
    echo "Sending commands to $container..."
    for cmd in "${commands[@]}"; do
        echo "Executing in $container: $cmd"
        echo "$cmd" | docker exec -i $container bash -c "npm run dev client" &
        sleep 0.5
    done
}

# Run commands for both clients in parallel
send_commands "raft-client-1" "${CLIENT1_COMMANDS[@]}" &
send_commands "raft-client-2" "${CLIENT2_COMMANDS[@]}" &

# Wait for all background processes to complete
wait

echo "All commands sent to both clients."
