
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
        version: '1.21.1', // Specific version
        auth: 'offline', // For cracked servers
        skipValidation: true, // Skip username validation
        checkTimeoutInterval: 30000,
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
    
    console.log('❌ Disconnected, retrying in 5 seconds...');
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, 5000);
  }

  startActivity() {
    if (this.activityInterval) return;
    
    // Keep the bot active by moving randomly every 10-30 seconds
    this.activityInterval = setInterval(() => {
      if (!this.connected || !this.bot) return;
      
      try {
        const actions = [
          () => this.bot.setControlState('jump', true),
          () => this.bot.setControlState('forward', true),
          () => this.bot.setControlState('back', true),
          () => this.bot.setControlState('left', true),
          () => this.bot.setControlState('right', true)
        ];
        
        // Perform a random action
        const action = actions[Math.floor(Math.random() * actions.length)];
        action();
        
        // Stop the action after a short time
        setTimeout(() => {
          if (this.bot) {
            this.bot.clearControlStates();
          }
        }, 100 + Math.random() * 200);
        
        console.log('🤖 Performing activity to stay active');
      } catch (error) {
        console.log('⚠ Activity error:', error.message);
      }
    }, 10000 + Math.random() * 20000); // Random interval between 10-30 seconds
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
