# Use an official Node.js runtime as the base image
FROM node:18

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json package-lock.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Compile TypeScript
RUN npm run build

# Expose ports (will be dynamically assigned)
EXPOSE 3000-3100

# Command to run the application (will be overridden by docker-compose)
CMD ["npm", "run", "dev", "server", "node1"]
