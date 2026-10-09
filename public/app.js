const socket = io();

// DOM Elements
const configSection = document.getElementById('configSection');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const urlDisplay = document.getElementById('urlDisplay');
const shareUrl = document.getElementById('shareUrl');
const connectionStatus = document.getElementById('connectionStatus');
const debugSection = document.getElementById('debugSection');
const debugLog = document.getElementById('debugLog');
const iceStatsSection = document.getElementById('iceStats');
const videoSection = document.getElementById('videoSection');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

// State
let roomId = null;
let peerConnection = null;
let localStream = null;
let isHost = false;
let myTurnConfig = null;
let peerTurnConfig = null;

// ICE Statistics
let iceStats = {
    total: 0,
    host: 0,
    srflx: 0,
    relay: 0,
    failed: 0
};

// Check if we're joining a room
const urlParams = new URLSearchParams(window.location.search);
const roomIdParam = urlParams.get('room');

// Also check for path-based URL like /room/12345
const pathMatch = window.location.pathname.match(/\/room\/(\d+)/);
const pathRoomId = pathMatch ? pathMatch[1] : null;

if (roomIdParam || pathRoomId) {
    roomId = roomIdParam || pathRoomId;
    createRoomBtn.classList.add('hidden');
    joinRoomBtn.classList.remove('hidden');
    document.getElementById('turnUrl').value = '';
    document.getElementById('turnUsername').value = '';
    document.getElementById('turnPassword').value = '';
    // Change button text to make it clear
    joinRoomBtn.textContent = 'Join Room';
    // Show debug sections immediately so user can see logs
    connectionStatus.classList.remove('hidden');
    debugSection.classList.remove('hidden');
    iceStatsSection.classList.remove('hidden');
    videoSection.classList.remove('hidden');
    log(`Detected room ID from URL: ${roomId}`, 'info');
    log('Please enter your TURN credentials and click "Join Room"', 'info');
}

// Logging function
function log(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${message}`;
    debugLog.appendChild(entry);
    debugLog.scrollTop = debugLog.scrollHeight;
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// Update ICE statistics display
function updateIceStats() {
    document.getElementById('totalCandidates').textContent = iceStats.total;
    document.getElementById('hostCandidates').textContent = iceStats.host;
    document.getElementById('srflxCandidates').textContent = iceStats.srflx;
    document.getElementById('relayCandidates').textContent = iceStats.relay;
    document.getElementById('failedCandidates').textContent = iceStats.failed;
}

// Create room
createRoomBtn.addEventListener('click', () => {
    const turnUrl = document.getElementById('turnUrl').value;
    const turnUsername = document.getElementById('turnUsername').value;
    const turnPassword = document.getElementById('turnPassword').value;
    const turnUsername2 = document.getElementById('turnUsername2').value;
    const turnPassword2 = document.getElementById('turnPassword2').value;

    if (!turnUrl || !turnUsername || !turnPassword) {
        alert('Please fill in TURN server configuration for Peer 1');
        return;
    }

    // Auto-format TURN URL if missing protocol
    let formattedUrl = turnUrl;
    if (!turnUrl.startsWith('turn:') && !turnUrl.startsWith('turns:')) {
        formattedUrl = `turn:${turnUrl}`;
        if (!turnUrl.includes(':')) {
            formattedUrl += ':3478';
        }
    }

    // Auto-add timestamp to username if not already in REST format
    let formattedUsername = turnUsername;
    if (!turnUsername.includes(':')) {
        const timestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
        formattedUsername = `${timestamp}:${turnUsername}`;
    }

    let formattedUsername2 = turnUsername2;
    if (turnUsername2 && !turnUsername2.includes(':')) {
        const timestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
        formattedUsername2 = `${timestamp}:${turnUsername2}`;
    }

    myTurnConfig = {
        urls: formattedUrl,
        username: formattedUsername,
        credential: turnPassword
    };

    const turnConfig2 = {
        urls: formattedUrl,
        username: formattedUsername2,
        credential: turnPassword2
    };

    socket.emit('create-room', { turnConfig: turnConfig2 });
});

// Join room
joinRoomBtn.addEventListener('click', () => {
    const turnUrl = document.getElementById('turnUrl').value;
    const turnUsername = document.getElementById('turnUsername').value;
    const turnPassword = document.getElementById('turnPassword').value;

    if (!turnUrl || !turnUsername || !turnPassword) {
        alert('Please fill in TURN server configuration');
        return;
    }

    // Auto-format TURN URL if missing protocol
    let formattedUrl = turnUrl;
    if (!turnUrl.startsWith('turn:') && !turnUrl.startsWith('turns:')) {
        formattedUrl = `turn:${turnUrl}`;
        if (!turnUrl.includes(':')) {
            formattedUrl += ':3478';
        }
    }

    // Auto-add timestamp to username if not already in REST format
    let formattedUsername = turnUsername;
    if (!turnUsername.includes(':')) {
        const timestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
        formattedUsername = `${timestamp}:${turnUsername}`;
    }

    myTurnConfig = {
        urls: formattedUrl,
        username: formattedUsername,
        credential: turnPassword
    };

    socket.emit('join-room', { roomId, turnConfig: myTurnConfig });
});

// Socket events
socket.on('room-created', (data) => {
    roomId = data.roomId;
    isHost = true;
    peerTurnConfig = data.turnConfig;
    
    const url = `${window.location.origin}/room/${roomId}`;
    shareUrl.textContent = url;
    urlDisplay.classList.remove('hidden');
    
    log(`Room created with ID: ${roomId}`, 'success');
    log(`Share this URL with Peer 2: ${url}`, 'info');
    log(`Your TURN config: ${JSON.stringify(myTurnConfig)}`, 'info');
    log(`Peer 2 TURN config (pre-configured): ${JSON.stringify(peerTurnConfig)}`, 'info');
    
    showDebugSections();
});

socket.on('room-joined', (data) => {
    isHost = false;
    peerTurnConfig = data.turnConfig;
    
    log(`Joined room: ${roomId}`, 'success');
    log(`Your TURN config: ${JSON.stringify(myTurnConfig)}`, 'info');
    log(`Peer 1 TURN config: ${JSON.stringify(peerTurnConfig)}`, 'info');
    
    showDebugSections();
    initializePeerConnection();
});

socket.on('peer-joined', (data) => {
    log('Peer 2 has joined the room', 'success');
    peerTurnConfig = data.turnConfig;
    log(`Peer 2 TURN config: ${JSON.stringify(peerTurnConfig)}`, 'info');
    
    initializePeerConnection();
});

socket.on('signal', async (data) => {
    log(`Received ${data.type} signal`, 'info');
    
    if (data.type === 'offer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('signal', { roomId, signal: answer, type: 'answer' });
        log('Sent answer', 'success');
    } else if (data.type === 'answer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal));
        log('Remote description set (answer)', 'success');
    }
});

socket.on('ice-candidate', async (data) => {
    if (data.candidate) {
        log(`Received ICE candidate from peer`, 'candidate');
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            log('ICE candidate added successfully', 'success');
        } catch (e) {
            log(`Error adding ICE candidate: ${e.message}`, 'error');
        }
    }
});

socket.on('error', (data) => {
    log(`Error: ${data.message}`, 'error');
    alert(data.message);
});

socket.on('host-disconnected', () => {
    log('Host has disconnected', 'error');
});

function showDebugSections() {
    connectionStatus.classList.remove('hidden');
    debugSection.classList.remove('hidden');
    iceStatsSection.classList.remove('hidden');
    videoSection.classList.remove('hidden');
    shareScreenBtn.classList.remove('hidden');
}

// Initialize Peer Connection
function initializePeerConnection() {
    log('Initializing peer connection...', 'info');
    
    const config = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    // Add TURN server if configured
    if (myTurnConfig && myTurnConfig.urls) {
        config.iceServers.push({
            urls: myTurnConfig.urls,
            username: myTurnConfig.username,
            credential: myTurnConfig.credential
        });
        log(`Added TURN server: ${myTurnConfig.urls}`, 'info');
    }

    if (peerTurnConfig && peerTurnConfig.urls) {
        config.iceServers.push({
            urls: peerTurnConfig.urls,
            username: peerTurnConfig.username,
            credential: peerTurnConfig.credential
        });
        log(`Added peer TURN server: ${peerTurnConfig.urls}`, 'info');
    }

    peerConnection = new RTCPeerConnection(config);

    // ICE candidate handling
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            iceStats.total++;
            analyzeIceCandidate(event.candidate);
            updateIceStats();
            
            log(`Generated ICE candidate: ${event.candidate.candidate}`, 'candidate');
            socket.emit('ice-candidate', { roomId, candidate: event.candidate });
        } else {
            log('ICE gathering complete', 'success');
        }
    };

    peerConnection.onicecandidateerror = (event) => {
        log(`ICE candidate error: ${event.errorText} (URL: ${event.url})`, 'error');
        iceStats.failed++;
        updateIceStats();
    };

    peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        document.getElementById('iceConnectionState').textContent = state;
        log(`ICE connection state changed: ${state}`, state === 'connected' || state === 'completed' ? 'success' : 'warning');
        
        if (state === 'failed') {
            log('ICE connection FAILED - analyzing potential causes...', 'error');
            analyzeConnectionFailure();
        } else if (state === 'connected' || state === 'completed') {
            log('ICE connection SUCCESSFUL!', 'success');
        }
    };

    peerConnection.onicegatheringstatechange = () => {
        const state = peerConnection.iceGatheringState;
        document.getElementById('iceGatheringState').textContent = state;
        log(`ICE gathering state changed: ${state}`, 'info');
    };

    peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        document.getElementById('connectionState').textContent = state;
        log(`Connection state changed: ${state}`, 'info');
    };

    peerConnection.onsignalingstatechange = () => {
        const state = peerConnection.signalingState;
        document.getElementById('signalingState').textContent = state;
        log(`Signaling state changed: ${state}`, 'info');
    };

    peerConnection.ontrack = (event) => {
        log('Received remote track', 'success');
        remoteVideo.srcObject = event.streams[0];
    };

    // Create offer if host
    if (isHost) {
        createOffer();
    }
}

// Analyze ICE candidate
function analyzeIceCandidate(candidate) {
    const candidateStr = candidate.candidate;
    
    if (candidateStr.includes('typ host')) {
        iceStats.host++;
        log('Host candidate (local network address)', 'candidate');
    } else if (candidateStr.includes('typ srflx')) {
        iceStats.srflx++;
        log('Server reflexive candidate (NAT public address)', 'candidate');
    } else if (candidateStr.includes('typ relay')) {
        iceStats.relay++;
        log('Relay candidate (TURN server address)', 'candidate');
    } else if (candidateStr.includes('typ prflx')) {
        log('Peer reflexive candidate', 'candidate');
    }

    // Network analysis
    if (candidateStr.includes('IPv4')) {
        log('Candidate uses IPv4', 'info');
    } else if (candidateStr.includes('IPv6')) {
        log('Candidate uses IPv6', 'info');
    }

    // Protocol analysis
    if (candidateStr.includes('UDP')) {
        log('Candidate uses UDP protocol', 'info');
    } else if (candidateStr.includes('TCP')) {
        log('Candidate uses TCP protocol', 'warning');
    }
}

// Analyze connection failure
function analyzeConnectionFailure() {
    log('=== CONNECTION FAILURE ANALYSIS ===', 'error');
    
    if (iceStats.relay === 0) {
        log('FAILURE: No relay candidates - TURN server may not be working', 'error');
        log('RECOMMENDATION: Verify TURN server URL, username, and password', 'warning');
    } else if (iceStats.srflx === 0) {
        log('FAILURE: No server reflexive candidates - STUN may be blocked', 'error');
        log('RECOMMENDATION: Check if UDP port 3478 is open on firewall', 'warning');
    } else if (iceStats.host === 0) {
        log('FAILURE: No host candidates - local network issue', 'error');
    }
    
    if (iceStats.failed > 0) {
        log(`FAILURE: ${iceStats.failed} candidates failed to gather`, 'error');
        log('RECOMMENDATION: Check network connectivity and firewall rules', 'warning');
    }
    
    log('=== END ANALYSIS ===', 'error');
}

// Create offer
async function createOffer() {
    log('Creating offer...', 'info');
    
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { roomId, signal: offer, type: 'offer' });
        log('Offer created and sent', 'success');
    } catch (e) {
        log(`Error creating offer: ${e.message}`, 'error');
    }
}

// Screen sharing
shareScreenBtn.addEventListener('click', async () => {
    if (!peerConnection) {
        log('Error: Peer connection not established. Wait for peer to join first.', 'error');
        alert('Please wait for the peer to join before starting screen share');
        return;
    }

    try {
        log('Requesting screen share...', 'info');
        localStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: "always"
            },
            audio: false
        });

        localVideo.srcObject = localStream;
        log('Screen share started', 'success');

        // Add tracks to peer connection
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
            log(`Added ${track.kind} track to peer connection`, 'info');
        });

        shareScreenBtn.disabled = true;
        shareScreenBtn.textContent = 'Screen Sharing Active';

    } catch (e) {
        log(`Error starting screen share: ${e.message}`, 'error');
    }
});

// Handle local stream end
localVideo.onended = () => {
    log('Screen share ended by user', 'warning');
    shareScreenBtn.disabled = false;
    shareScreenBtn.textContent = 'Start Screen Share';
};
