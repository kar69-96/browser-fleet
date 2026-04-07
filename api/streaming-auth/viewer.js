// Vercel serverless function to proxy streaming viewer
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email } = req.query;
    const streamingServerUrl = process.env.STREAMING_SERVER_URL;

    if (!streamingServerUrl) {
      return res.status(500).send('Streaming server not configured');
    }

    // Serve HTML that connects to EC2 streaming server
    // Socket.IO will connect directly to EC2 for WebSocket performance
    res.setHeader('Content-Type', 'text/html');
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Streaming Login</title>
  <script src="https://cdn.socket.io/4.6.0/socket.io.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #fff;
    }
    #canvas {
      display: block;
      width: 100%;
      height: 100%;
      cursor: pointer;
      object-fit: contain;
    }
    .loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: #666;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .spinner {
      border: 4px solid #f3f3f3;
      border-top: 4px solid #667eea;
      border-radius: 50%;
      width: 50px;
      height: 50px;
      animation: spin 1s linear infinite;
      margin: 0 auto 15px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="loading" id="loading">
    <div class="spinner"></div>
    <p>Loading...</p>
  </div>
  <canvas id="canvas" class="hidden"></canvas>

  <script>
    // Connect to EC2 streaming server
    const socket = io('${streamingServerUrl}', {
      transports: ['websocket', 'polling'],
      upgrade: true
    });

    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const loading = document.getElementById('loading');
    let isConnected = false;
    let canvasReady = false;

    socket.on('connect', () => {
      console.log('Connected to streaming server');
      isConnected = true;
    });

    socket.on('frame', (data) => {
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        if (!canvasReady) {
          loading.classList.add('hidden');
          canvas.classList.remove('hidden');
          canvasReady = true;
        }
      };
      img.src = 'data:image/jpeg;base64,' + data;
    });

    socket.on('extraction-complete', (data) => {
      console.log('Extraction complete!', data);

      // Notify parent window
      if (window.opener) {
        window.opener.postMessage({
          type: 'streaming-login-complete',
          data: {
            success: true,
            ...data
          }
        }, '*');
      }

      // Close after a short delay
      setTimeout(() => window.close(), 1500);
    });

    socket.on('error', (message) => {
      loading.innerHTML = '<p style="color: #c33;">Error: ' + message + '</p>';

      // Notify parent of error
      if (window.opener) {
        window.opener.postMessage({
          type: 'streaming-login-error',
          error: message
        }, '*');
      }
    });

    // Mouse events
    canvas.addEventListener('mousemove', (e) => {
      if (!isConnected || !canvasReady) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);
      socket.emit('mouse-move', { x, y });
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!isConnected || !canvasReady) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);
      socket.emit('mouse-down', { x, y, button: e.button === 2 ? 'right' : 'left' });
    });

    canvas.addEventListener('mouseup', (e) => {
      if (!isConnected || !canvasReady) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);
      socket.emit('mouse-up', { x, y, button: e.button === 2 ? 'right' : 'left' });
    });

    canvas.addEventListener('click', (e) => {
      if (!isConnected || !canvasReady) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);
      socket.emit('mouse-click', { x, y, button: 'left' });
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    // Keyboard events
    document.addEventListener('keydown', (e) => {
      if (!isConnected || !canvasReady) return;
      socket.emit('key-down', { key: e.key, code: e.code });
      if (e.key !== 'F5' && e.key !== 'F12') {
        e.preventDefault();
      }
    });

    document.addEventListener('keyup', (e) => {
      if (!isConnected || !canvasReady) return;
      socket.emit('key-up', { key: e.key, code: e.code });
    });
  </script>
</body>
</html>
    `);

  } catch (error) {
    console.error('Streaming viewer error:', error);
    return res.status(500).send('Failed to load streaming viewer');
  }
};
