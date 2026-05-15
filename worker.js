// Cloudflare Worker with Durable Object for WebRTC signaling

// ------------------- Durable Object (one per room) -------------------
export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.connections = new Set(); // WebSocket connections
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.connections.add(server);

    server.accept();
    server.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      // Forward message to all other connections in the room
      for (const conn of this.connections) {
        if (conn !== server) {
          conn.send(JSON.stringify(data));
        }
      }
    });

    server.addEventListener('close', () => {
      this.connections.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

// ------------------- Main Worker -------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve the HTML UI for root path
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(HTML_CONTENT, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // WebSocket signaling endpoint: /room/:roomId
    const match = url.pathname.match(/^\/room\/([^\/]+)$/);
    if (match) {
      const roomId = match[1];
      const id = env.ROOM_SIGNALING.idFromName(roomId);
      const room = env.ROOM_SIGNALING.get(id);
      return room.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ------------------- Embedded HTML/CSS/JS -------------------
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
  <title>Tab/Window Share - Cloudflare</title>
  <style>
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    body { background: #1e1e2f; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .container { background: #2d2d3f; border-radius: 24px; padding: 20px; width: 100%; max-width: 1200px; box-shadow: 0 8px 20px rgba(0,0,0,0.3); }
    h1 { margin: 0 0 8px 0; color: #fff; font-size: 1.6rem; }
    .sub { color: #aaa; margin-bottom: 20px; font-size: 0.9rem; }
    .room-controls { background: #3a3a4e; border-radius: 20px; padding: 16px; margin-bottom: 20px; display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
    .room-controls div { flex: 1; min-width: 150px; }
    label { display: block; color: #ccc; font-size: 0.75rem; margin-bottom: 5px; font-weight: 500; }
    input, button { width: 100%; padding: 10px 14px; border-radius: 14px; border: none; font-size: 1rem; }
    input { background: #1e1e2f; color: white; border: 1px solid #555; }
    button { background: #5865f2; color: white; font-weight: bold; cursor: pointer; transition: 0.2s; }
    button:hover { background: #4752c4; }
    button.danger { background: #dc2626; }
    button.danger:hover { background: #b91c1c; }
    button.secondary { background: #4b5563; }
    .video-grid { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 20px; }
    .video-card { background: #1e1e2f; border-radius: 16px; overflow: hidden; flex: 1 1 400px; border: 1px solid #444; }
    .video-card h3 { margin: 0; padding: 8px 12px; background: #000000aa; color: white; font-size: 0.8rem; font-weight: normal; }
    video { width: 100%; background: #000; aspect-ratio: 16/9; object-fit: cover; display: block; }
    .status { background: #0f0f1a; padding: 10px 12px; border-radius: 12px; margin-top: 16px; color: #0f0; font-family: monospace; font-size: 0.8rem; word-break: break-word; }
    .controls-bar { display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
    .badge { background: #5865f2; padding: 4px 12px; border-radius: 999px; font-size: 0.7rem; font-weight: bold; display: inline-block; }
    .info-note { background: #2a2a3c; border-radius: 12px; padding: 8px 12px; margin-top: 12px; font-size: 0.75rem; color: #ccc; }
    @media (max-width: 640px) {
      .container { padding: 16px; }
      h1 { font-size: 1.3rem; }
      .room-controls { flex-direction: column; align-items: stretch; }
      button { padding: 12px; }
    }
  </style>
</head>
<body>
<div class="container">
  <h1>📺 Tab / Window Share</h1>
  <div class="sub">Share your screen (desktop/Android) – others join with same Room ID (any device)</div>

  <div class="room-controls">
    <div>
      <label>🔑 Session (Room) ID</label>
      <input type="text" id="roomIdInput" placeholder="e.g., meeting-123" value="demo-room">
    </div>
    <div>
      <label>👤 Your Name (optional)</label>
      <input type="text" id="userName" placeholder="Anonymous">
    </div>
    <div style="flex: 0 0 auto">
      <button id="joinBtn">🚪 Join Session</button>
    </div>
  </div>

  <div id="shareArea" style="display: none;">
    <div class="controls-bar">
      <button id="startShareBtn">🖥️ Share Tab / Screen</button>
      <button id="stopShareBtn" class="danger">⏹️ Stop Sharing</button>
    </div>
    <div class="info-note">
      💡 On Android: you can share your entire screen.<br>
      📱 On iPhone/iPad: viewing only (Apple does not allow screen capture from browser).<br>
      🖥️ On Windows/Mac/Chromebook: sharing works with one click (prefers current tab).
    </div>
  </div>

  <div id="videoGrid" class="video-grid"></div>
  <div id="status" class="status">⚡ Not connected. Enter a room ID and click "Join Session".</div>
</div>

<script>
  // DOM elements
  const roomIdInput = document.getElementById('roomIdInput');
  const joinBtn = document.getElementById('joinBtn');
  const shareArea = document.getElementById('shareArea');
  const startShareBtn = document.getElementById('startShareBtn');
  const stopShareBtn = document.getElementById('stopShareBtn');
  const videoGrid = document.getElementById('videoGrid');
  const statusDiv = document.getElementById('status');

  let ws = null;
  let localStream = null;
  let peerConnections = new Map(); // peerId -> RTCPeerConnection
  let currentRoom = null;
  let myId = null;

  const configuration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  };

  function logStatus(msg, isError = false) {
    statusDiv.innerHTML = \`\${isError ? '❌' : '✅'} \${msg}\`;
    statusDiv.style.color = isError ? '#ff8888' : '#88ff88';
    console.log(msg);
  }

  async function createPeerConnection(remoteId) {
    const pc = new RTCPeerConnection(configuration);
    peerConnections.set(remoteId, pc);

    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ice-candidate', to: remoteId, candidate: event.candidate }));
      }
    };

    pc.ontrack = (event) => {
      addRemoteVideo(remoteId, event.streams[0]);
    };

    return pc;
  }

  function addRemoteVideo(peerId, stream) {
    let container = document.getElementById(\`video-\${peerId}\`);
    if (!container) {
      container = document.createElement('div');
      container.className = 'video-card';
      container.id = \`video-\${peerId}\`;
      container.innerHTML = \`<h3>📡 \${peerId}</h3><video autoplay playsinline muted></video>\`;
      videoGrid.appendChild(container);
    }
    const video = container.querySelector('video');
    video.srcObject = stream;
    video.play().catch(e => console.warn("Autoplay blocked?", e));
  }

  function removeRemoteVideo(peerId) {
    const el = document.getElementById(\`video-\${peerId}\`);
    if (el) el.remove();
  }

  async function closePeerConnection(peerId) {
    const pc = peerConnections.get(peerId);
    if (pc) {
      pc.close();
      peerConnections.delete(peerId);
    }
    removeRemoteVideo(peerId);
  }

  async function updateLocalStreamInPeers(newStream) {
    localStream = newStream;
    for (const [remoteId, pc] of peerConnections.entries()) {
      const senders = pc.getSenders();
      // Remove old video tracks
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'video') {
          pc.removeTrack(sender);
        }
      }
      // Add new video track if we have a stream
      if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
          pc.addTrack(videoTrack, localStream);
        }
      }
      // Re-negotiate
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', to: remoteId, offer }));
    }
  }

  async function startSharing() {
    if (!ws) { logStatus("Join a session first", true); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
        preferCurrentTab: true  // works on Chrome/Edge/Chromebook/Android
      });
      await updateLocalStreamInPeers(stream);
      logStatus("Sharing started (tab/window/screen)");
      // Stop sharing when user clicks browser's "Stop sharing" button
      stream.getVideoTracks()[0].onended = () => stopSharing();
    } catch (err) {
      console.error(err);
      let msg = err.message;
      if (err.name === 'NotAllowedError') msg = "Permission denied or screen picker cancelled";
      else if (err.name === 'NotFoundError') msg = "No screen capture source available";
      logStatus("Failed to share: " + msg, true);
    }
  }

  function stopSharing() {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      updateLocalStreamInPeers(null);
      logStatus("Sharing stopped");
    }
  }

  async function joinRoom() {
    const roomId = roomIdInput.value.trim();
    if (!roomId) { logStatus("Enter a room ID", true); return; }
    // Cleanup previous connection
    if (ws) {
      ws.close();
      ws = null;
    }
    for (const [id, pc] of peerConnections.entries()) pc.close();
    peerConnections.clear();
    videoGrid.innerHTML = '';
    stopSharing();
    shareArea.style.display = 'none';

    currentRoom = roomId;
    const userName = document.getElementById('userName').value.trim() || "Anonymous";
    myId = userName + "-" + Math.random().toString(36).substr(2, 6);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${location.host}/room/\${encodeURIComponent(roomId)}\`;
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      logStatus(\`Connected to session '\${roomId}' as \${myId}\`);
      shareArea.style.display = 'block';
      // Notify others about our presence (optional, used for display)
      ws.send(JSON.stringify({ type: 'join', id: myId }));
    };
    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'offer':
          {
            let pc = peerConnections.get(data.from);
            if (!pc) pc = await createPeerConnection(data.from);
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'answer', to: data.from, answer }));
          }
          break;
        case 'answer':
          {
            const pc = peerConnections.get(data.from);
            if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          }
          break;
        case 'ice-candidate':
          {
            const pc = peerConnections.get(data.from);
            if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
          break;
        case 'peer-left':
          closePeerConnection(data.from);
          break;
      }
    };
    ws.onclose = () => {
      logStatus("Disconnected from signaling server", true);
      shareArea.style.display = 'none';
      stopSharing();
      // Clear video grid
      for (const [id, pc] of peerConnections.entries()) pc.close();
      peerConnections.clear();
      videoGrid.innerHTML = '';
    };
    ws.onerror = (err) => {
      console.error("WebSocket error", err);
      logStatus("WebSocket error", true);
    };
  }

  // Event listeners
  joinBtn.addEventListener('click', joinRoom);
  startShareBtn.addEventListener('click', startSharing);
  stopShareBtn.addEventListener('click', stopSharing);

  // Auto-generate a username if empty
  if (!document.getElementById('userName').value) {
    document.getElementById('userName').value = "User-" + Math.floor(Math.random() * 10000);
  }
</script>
</body>
</html>`;
