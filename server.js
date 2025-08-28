
const express = require('express');

class StatusServer {
  constructor(bot) {
    this.bot = bot;
    this.app = express();
    this.setupRoutes();
  }

  setupRoutes() {
    // JSON status endpoint for UptimeRobot
    this.app.get('/status', (req, res) => {
      const status = this.bot.getStatus();
      res.json({
        connected: status.connected,
        lastError: status.lastError,
        status: status.status,
        server: status.server,
        username: status.username,
        timestamp: new Date().toISOString()
      });
    });

    // HTML status page
    this.app.get('/', (req, res) => {
      const status = this.bot.getStatus();

      let statusIcon, statusText, statusColor;

      if (status.status === 'connected') {
        statusIcon = '✅';
        statusText = 'Connected';
        statusColor = '#28a745';
      } else if (status.status === 'connecting') {
        statusIcon = '⏳';
        statusText = 'Connecting...';
        statusColor = '#ffc107';
      } else if (status.status === 'waiting_for_players_to_leave') {
        statusIcon = '👨‍💻';
        statusText = 'Waiting for real players to leave';
        statusColor = '#17a2b8';
      } else {
        statusIcon = '❌';
        statusText = 'Not Connected (waiting/retrying)';
        statusColor = '#dc3545';
      }

      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Minecraft AFK Bot Status</title>
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              max-width: 600px;
              margin: 50px auto;
              padding: 20px;
              background: #f5f5f5;
            }
            .container {
              background: white;
              padding: 30px;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .status {
              font-size: 24px;
              font-weight: bold;
              color: ${statusColor};
              margin: 20px 0;
            }
            .info {
              background: #f8f9fa;
              padding: 15px;
              border-radius: 5px;
              margin: 15px 0;
            }
            .error {
              background: #f8d7da;
              border: 1px solid #f5c6cb;
              color: #721c24;
              padding: 15px;
              border-radius: 5px;
              margin: 15px 0;
            }
            .refresh {
              text-align: center;
              margin-top: 20px;
            }
            button {
              background: #007bff;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 5px;
              cursor: pointer;
            }
            button:hover {
              background: #0056b3;
            }
          </style>
          <script>
            function refreshStatus() {
              location.reload();
            }
            // Auto-refresh every 10 seconds
            setInterval(refreshStatus, 10000);
          </script>
        </head>
        <body>
          <div class="container">
            <h1>🤖 Minecraft AFK Bot</h1>

            <div class="status">
              ${statusIcon} ${statusText}
            </div>

            <div class="info">
              <strong>Server:</strong> ${status.server}<br>
              <strong>Current Username:</strong> ${status.username}<br>
              <strong>Username Counter:</strong> ${status.usernameCounter || 1}<br>
              ${status.bannedUsernames && status.bannedUsernames.length > 0 ? 
                `<strong>Banned Usernames:</strong> ${status.bannedUsernames.join(', ')}<br>` : ''}
              ${status.realPlayersOnline && status.realPlayersOnline.length > 0 ? 
                `<strong>Real Players Online:</strong> ${status.realPlayersOnline.join(', ')}<br>` : 
                '<strong>Real Players Online:</strong> None<br>'}
              ${status.isHidingFromPlayers ? '<strong>🚪 Bot Status:</strong> Hiding from real players<br>' : ''}
              <strong>Last Update:</strong> ${new Date().toLocaleString()}
            </div>

            ${status.lastError ? `
              <div class="error">
                <strong>⚠ Last Error:</strong><br>
                ${status.lastError}
              </div>
            ` : ''}

            <div class="refresh">
              <button onclick="refreshStatus()">🔄 Refresh Status</button>
            </div>

            <p><small>Page auto-refreshes every 10 seconds</small></p>
          </div>
        </body>
        </html>
      `;

      res.send(html);
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
  }

  start(port = 5000) {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, '0.0.0.0', () => {
        console.log(`🌐 Status server running on http://0.0.0.0:${port}`);
        console.log(`📊 Status page: http://0.0.0.0:${port}/`);
        console.log(`📡 API endpoint: http://0.0.0.0:${port}/status`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = StatusServer;
