# P2P Debugger - WebRTC ICE Analysis Tool

A powerful P2P debugging tool for WebRTC connections with detailed ICE candidate analysis, network diagnostics, and screen sharing capabilities.

## Features

- **Real-time ICE Candidate Debugging**: See exactly what's happening during the ICE candidate exchange
- **Network Architecture Analysis**: Detailed logs showing host, server reflexive, and relay candidates
- **Connection Failure Diagnosis**: Automatic analysis of why connections fail with specific recommendations
- **Screen Sharing**: Share your screen between peers using WebRTC
- **TURN Server Support**: Configure custom TURN servers for both peers
- **5-Digit Room IDs**: Easy-to-share room identifiers
- **Live Statistics**: Track candidate types, success/failure rates, and connection states

## How It Works

1. **Peer 1 (Host)**:
   - Opens the website
   - Enters TURN server URL and credentials for both peers
   - Clicks "Create Room" to generate a 5-digit room ID
   - Shares the URL with Peer 2

2. **Peer 2**:
   - Opens the shared URL
   - Enters their TURN server credentials
   - Clicks "Join Room"
   - Automatically uses the pre-configured TURN credentials from Peer 1

3. **Connection Process**:
   - Both peers can see detailed ICE candidate exchange logs
   - Real-time statistics show candidate types (host, srflx, relay)
   - If connection fails, the tool analyzes why and provides specific recommendations
   - Once connected, either peer can start screen sharing

## Local Development

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server will run on `http://localhost:3000`

## Deployment on Render

1. Push this repository to GitHub
2. Go to [Render](https://render.com)
3. Click "New +" and select "Web Service"
4. Connect your GitHub repository
5. Render will automatically detect the `render.yaml` configuration
6. Click "Create Web Service"

The `render.yaml` file is pre-configured with:
- Node.js environment
- Free tier plan
- Automatic build and deployment

## TURN Server Configuration

You'll need a TURN server for reliable P2P connections, especially when peers are behind NAT/firewalls.

### Using coturn (recommended)

```bash
# Install coturn
sudo apt-get install coturn

# Configure /etc/turnserver.conf
listening-port=3478
fingerprint
lt-cred-mech
user=username1:password1
user=username2:password2
realm=yourdomain.com
```

### Using a commercial TURN service

You can use services like:
- Twilio Network Traversal
- Xirsys
- Metered TURN

## ICE Candidate Types Explained

- **Host Candidates**: Local network addresses (e.g., 192.168.x.x)
- **Server Reflexive (srflx)**: Public addresses discovered via STUN
- **Relay Candidates**: Addresses relayed through TURN server
- **Peer Reflexive (prflx)**: Discovered during connectivity checks

## Troubleshooting

### Connection Fails

The tool will automatically analyze failures and provide recommendations:

1. **No relay candidates**: TURN server may be misconfigured or unreachable
2. **No server reflexive candidates**: STUN server blocked by firewall
3. **No host candidates**: Local network issue
4. **Candidate failures**: Network connectivity or firewall issues

### Common Issues

- **UDP blocked**: Ensure UDP port 3478 is open on firewalls
- **TURN credentials**: Verify username and password are correct
- **NAT type**: Symmetric NAT may require TURN relay
- **IPv6 issues**: Some networks have IPv6 connectivity problems

## Architecture

- **Backend**: Node.js with Express and Socket.io for signaling
- **Frontend**: Vanilla JavaScript with WebRTC API
- **Signaling**: Socket.io for real-time peer coordination
- **Media**: WebRTC for screen sharing and P2P communication

## License

MIT
