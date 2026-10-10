FROM node:18

# Install Python
RUN apt-get update && apt-get install -y python3 python3-pip

# Install Python dependencies
COPY wms_p2p_diag_og.py .
RUN pip3 install requests pycryptodome

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Copy source
COPY . .

# Expose port
EXPOSE 10000

# Start server
CMD ["node", "server.js"]
