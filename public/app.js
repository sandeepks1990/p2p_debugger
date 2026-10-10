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
const wmsUrlInput = document.getElementById('wmsUrl');
const groupTokenInput = document.getElementById('groupToken');
const fetchCredentialsBtn = document.getElementById('fetchCredentialsBtn');
const updateConfigBtn = document.getElementById('updateConfigBtn');
const turnStatus = document.getElementById('turnStatus');
const turnServerInput = document.getElementById('turnServer');
const turnUsernameInput = document.getElementById('turnUsername');
const turnPasswordInput = document.getElementById('turnPassword');

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

// Signaling Statistics
let signalingStats = {
    offers: 0,
    answers: 0,
    iceCandidatesSent: 0,
    iceCandidatesReceived: 0
};

// Check if we're joining a room
const urlParams = new URLSearchParams(window.location.search);
const roomIdParam = urlParams.get('room');

// Also check for path-based URL like /room/12345
const pathMatch = window.location.pathname.match(/\/room\/(\d+)/);
const pathRoomId = pathMatch ? pathMatch[1] : null;

// Debug: log what we're seeing
console.log('URL pathname:', window.location.pathname);
console.log('URL search:', window.location.search);
console.log('Room ID from query:', roomIdParam);
console.log('Room ID from path:', pathRoomId);

// Load WMS configuration
async function loadWmsConfig() {
    try {
        const response = await fetch('/api/wms-config');
        const config = await response.json();
        wmsUrlInput.value = config.wmsUrl;
        groupTokenInput.value = config.groupToken;
        log('Loaded WMS configuration', 'info');
    } catch (e) {
        log('Failed to load WMS configuration', 'error');
    }
}

// Fetch TURN credentials from WMS
async function fetchTurnCredentials() {
    try {
        log('Fetching TURN credentials from WMS...', 'info');
        const response = await fetch('/api/turn-credentials');
        const data = await response.json();

        if (data.success) {
            myTurnConfig = data.config;
            turnServerInput.value = data.config.urls;
            turnUsernameInput.value = data.config.username;
            turnPasswordInput.value = data.config.credential;
            turnStatus.classList.remove('hidden');
            createRoomBtn.classList.remove('hidden');
            log('TURN credentials fetched successfully', 'success');
            log(`TURN Server: ${data.config.urls}`, 'info');
            log(`Username: ${data.config.username}`, 'info');
        } else {
            log(`Failed to fetch TURN credentials: ${data.error}`, 'error');
        }
    } catch (e) {
        log(`Error fetching TURN credentials: ${e.message}`, 'error');
    }
}

// Update WMS configuration
async function updateWmsConfig() {
    try {
        const response = await fetch('/api/wms-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wmsUrl: wmsUrlInput.value,
                groupToken: groupTokenInput.value
            })
        });
        const config = await response.json();
        log('WMS configuration updated', 'success');
    } catch (e) {
        log(`Failed to update WMS configuration: ${e.message}`, 'error');
    }
}

// Initialize page
loadWmsConfig();

if (roomIdParam || pathRoomId) {
    roomId = roomIdParam || pathRoomId;
    createRoomBtn.classList.add('hidden');
    joinRoomBtn.classList.remove('hidden');
    // Hide WMS config for Peer 2
    document.getElementById('wmsConfigFields').classList.add('hidden');
    document.getElementById('configTitle').textContent = 'Join Room';
    // Change button text to make it clear
    joinRoomBtn.textContent = 'Join Room';
    // Show debug sections immediately so user can see logs
    connectionStatus.classList.remove('hidden');
    debugSection.classList.remove('hidden');
    iceStatsSection.classList.remove('hidden');
    document.getElementById('signalingStats').classList.remove('hidden');
    videoSection.classList.remove('hidden');
    shareScreenBtn.classList.add('hidden'); // Hide screen share until connected
    log(`Detected room ID from URL: ${roomId}`, 'info');
    log('Click "Join Room" to connect (credentials pre-configured by Peer 1)', 'info');
    // Auto-fetch credentials for Peer 2
    fetchTurnCredentials();
} else {
    console.log('No room ID detected, showing create room button');
    // Auto-fetch credentials for Peer 1
    fetchTurnCredentials();
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

// Update signaling statistics display
function updateSignalingStats() {
    document.getElementById('offerCount').textContent = signalingStats.offers;
    document.getElementById('answerCount').textContent = signalingStats.answers;
    document.getElementById('iceSentCount').textContent = signalingStats.iceCandidatesSent;
    document.getElementById('iceReceivedCount').textContent = signalingStats.iceCandidatesReceived;
}

// Event listeners
fetchCredentialsBtn.addEventListener('click', fetchTurnCredentials);
updateConfigBtn.addEventListener('click', updateWmsConfig);

// Create room
createRoomBtn.addEventListener('click', () => {
    if (!myTurnConfig) {
        alert('Please fetch TURN credentials first');
        return;
    }

    socket.emit('create-room', { turnConfig: myTurnConfig });
});

// Join room
joinRoomBtn.addEventListener('click', () => {
    // Peer 2 doesn't need to enter credentials - they're pre-configured by Peer 1
    // Send empty config and let server provide the pre-configured one
    socket.emit('join-room', { roomId, turnConfig: {} });
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
    log(`TURN config: ${JSON.stringify(myTurnConfig)}`, 'info');

    showDebugSections();
});

socket.on('room-joined', (data) => {
    isHost = false;
    // Use the TURN config provided by the server (from Peer 1)
    myTurnConfig = data.turnConfig;
    peerTurnConfig = data.turnConfig;

    log(`Joined room: ${roomId}`, 'success');
    log(`Using TURN config from Peer 1: ${JSON.stringify(myTurnConfig)}`, 'info');

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
        signalingStats.offers++;
        updateSignalingStats();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('signal', { roomId, signal: answer, type: 'answer' });
        signalingStats.answers++;
        updateSignalingStats();
        log('Sent answer', 'success');
    } else if (data.type === 'answer') {
        signalingStats.answers++;
        updateSignalingStats();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal));
        log('Remote description set (answer)', 'success');
    }
});

socket.on('ice-candidate', async (data) => {
    if (data.candidate) {
        signalingStats.iceCandidatesReceived++;
        updateSignalingStats();
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
    document.getElementById('signalingStats').classList.remove('hidden');
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

    // Don't add peer TURN server if it's the same as ours
    if (peerTurnConfig && peerTurnConfig.urls && peerTurnConfig.urls !== myTurnConfig.urls) {
        config.iceServers.push({
            urls: peerTurnConfig.urls,
            username: peerTurnConfig.username,
            credential: peerTurnConfig.credential
        });
        log(`Added peer TURN server: ${peerTurnConfig.urls}`, 'info');
    }

    log(`ICE config: ${JSON.stringify(config.iceServers)}`, 'info');
    peerConnection = new RTCPeerConnection(config);

    // ICE candidate handling
    peerConnection.onicecandidate = (event) => {
        log(`ICE candidate event: candidate=${event.candidate ? 'yes' : 'no (null)'}`, 'info');
        if (event.candidate) {
            iceStats.total++;
            analyzeIceCandidate(event.candidate);
            updateIceStats();
            signalingStats.iceCandidatesSent++;
            updateSignalingStats();

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
        if (state === 'complete' && iceStats.total === 0) {
            log('WARNING: ICE gathering completed but no candidates were generated!', 'error');
            log('This usually means TURN server credentials are invalid or server is unreachable', 'error');
        }
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

    // Check ICE candidates
    if (iceStats.total === 0) {
        log('CRITICAL: No ICE candidates were generated at all', 'error');
        log('Possible causes:', 'error');
        log('  1. TURN server credentials are invalid or expired', 'error');
        log('  2. TURN server is unreachable (network/firewall issue)', 'error');
        log('  3. TURN server requires TLS but using plain TURN', 'error');
        log('RECOMMENDATION: Verify TURN credentials and try using turns:// instead of turn://', 'warning');
    } else if (iceStats.relay === 0) {
        log('FAILURE: No relay candidates - TURN server may not be working', 'error');
        log('RECOMMENDATION: Verify TURN server URL, username, and password', 'warning');
    } else if (iceStats.srflx === 0) {
        log('FAILURE: No server reflexive candidates - STUN may be blocked', 'error');
        log('RECOMMENDATION: Check if UDP port 3478 is open on firewall', 'warning');
    } else if (iceStats.host === 0) {
        log('FAILURE: No host candidates - local network issue', 'error');
    }

    // Check signaling
    if (signalingStats.offers === 0) {
        log('FAILURE: No offer was sent - peer connection not initialized', 'error');
    }
    if (signalingStats.answers === 0) {
        log('FAILURE: No answer was received - peer may not have joined', 'error');
    }
    if (signalingStats.iceCandidatesReceived === 0 && signalingStats.iceCandidatesSent > 0) {
        log('FAILURE: ICE candidates sent but none received - peer may have disconnected', 'error');
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
