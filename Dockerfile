FROM node:18

# Install Python
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip3 install requests pycryptodome

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Copy all source files
COPY . .

# Expose port
EXPOSE 10000

# Start server
CMD ["node", "server.js"]
