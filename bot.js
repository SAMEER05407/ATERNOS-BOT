
const mineflayer = require('mineflayer');

class MinecraftBot {
  constructor(config) {
    this.config = config;
    this.bot = null;
    this.connected = false;
    this.lastError = null;
    this.reconnectTimeout = null;
    this.activityInterval = null;
    this.status = 'disconnected'; // disconnected, connecting, connected
  }

  connect() {
    if (this.status === 'connecting') return;
    
    this.status = 'connecting';
    this.connected = false;
    console.log('⏳ Connecting to server...');

    try {
      this.bot = mineflayer.createBot({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        // version will be auto-detected
        auth: 'offline', // For cracked servers
        skipValidation: true, // Skip username validation
        checkTimeoutInterval: 60000, // Increased timeout
        hideErrors: false
      });

      this.setupEventHandlers();
    } catch (error) {
      this.handleError('Connection creation failed', error);
    }
  }

  setupEventHandlers() {
    this.bot.on('login', () => {
      console.log('🔐 Logged in to server...');
    });

    this.bot.on('spawn', () => {
      console.log('✅ Connected and spawned successfully!');
      this.connected = true;
      this.status = 'connected';
      this.lastError = null;
      this.startActivity();
    });

    this.bot.on('kicked', (reason) => {
      console.log('❌ Kicked from server:', reason);
      this.handleDisconnect('Kicked: ' + reason);
    });

    this.bot.on('end', (reason) => {
      console.log('❌ Connection ended:', reason);
      this.handleDisconnect('Connection ended: ' + reason);
    });

    this.bot.on('error', (err) => {
      console.log('⚠ Bot error:', err.message);
      this.handleError('Bot error', err);
    });

    this.bot.on('death', () => {
      console.log('💀 Bot died, respawning...');
    });
  }

  handleDisconnect(reason) {
    this.connected = false;
    this.status = 'disconnected';
    this.lastError = reason;
    this.stopActivity();
    this.scheduleReconnect();
  }

  handleError(message, error) {
    this.connected = false;
    this.status = 'disconnected';
    this.lastError = `${message}: ${error.message}`;
    console.log('⚠ Error:', this.lastError);
    this.stopActivity();
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    
    console.log('❌ Disconnected, retrying in 15 seconds...');
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, 15000);
  }

  startActivity() {
    if (this.activityInterval) return;
    
    // Keep the bot active with continuous movement patterns
    this.activityInterval = setInterval(() => {
      if (!this.connected || !this.bot) return;
      
      try {
        // Random movement patterns for exploration
        const movementPatterns = [
          () => {
            // Walk forward and jump occasionally
            this.bot.setControlState('forward', true);
            if (Math.random() < 0.3) this.bot.setControlState('jump', true);
          },
          () => {
            // Turn and walk
            this.bot.setControlState('left', true);
            this.bot.setControlState('forward', true);
          },
          () => {
            // Turn and walk
            this.bot.setControlState('right', true);
            this.bot.setControlState('forward', true);
          },
          () => {
            // Walk backward
            this.bot.setControlState('back', true);
          },
          () => {
            // Sprint forward
            this.bot.setControlState('forward', true);
            this.bot.setControlState('sprint', true);
          }
        ];
        
        // Clear previous states
        this.bot.clearControlStates();
        
        // Perform random movement
        const pattern = movementPatterns[Math.floor(Math.random() * movementPatterns.length)];
        pattern();
        
        // Continue movement for longer duration
        const moveDuration = 2000 + Math.random() * 3000; // 2-5 seconds
        setTimeout(() => {
          if (this.bot) {
            this.bot.clearControlStates();
            
            // Small pause between movements
            setTimeout(() => {
              if (this.bot && this.connected) {
                // Look around randomly
                const yaw = Math.random() * Math.PI * 2;
                const pitch = (Math.random() - 0.5) * 0.5;
                this.bot.look(yaw, pitch);
              }
            }, 500);
          }
        }, moveDuration);
        
        console.log('🤖 Bot exploring map - continuous movement');
      } catch (error) {
        console.log('⚠ Movement error:', error.message);
      }
    }, 3000 + Math.random() * 2000); // More frequent movement every 3-5 seconds
  }

  stopActivity() {
    if (this.activityInterval) {
      clearInterval(this.activityInterval);
      this.activityInterval = null;
    }
  }

  getStatus() {
    return {
      connected: this.connected,
      status: this.status,
      lastError: this.lastError,
      username: this.config.username,
      server: `${this.config.host}:${this.config.port}`
    };
  }

  disconnect() {
    this.stopActivity();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.bot) {
      this.bot.quit();
    }
    this.connected = false;
    this.status = 'disconnected';
  }
}

module.exports = MinecraftBot;
