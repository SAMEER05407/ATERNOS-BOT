
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
    this.baseUsername = 'DARK_WORLD';
    this.usernameCounter = 1;
    this.currentUsername = `${this.baseUsername}_${this.usernameCounter}`;
    this.isShuttingDown = false;
    this.bannedUsernames = new Set(); // Track banned usernames
    this.realPlayersOnline = new Set(); // Track real players (non-bot players)
    this.playerCheckInterval = null;
    this.isHidingFromPlayers = false; // Flag to track if bot is hiding from real players
  }

  connect() {
    if (this.status === 'connecting' || this.isShuttingDown) return;

    // Disconnect any existing bot first
    if (this.bot && typeof this.bot.quit === 'function') {
      try {
        this.bot.quit();
      } catch (error) {
        console.log('⚠ Error quitting bot:', error.message);
      }
      this.bot = null;
    }

    this.status = 'connecting';
    this.connected = false;

    console.log(`⏳ Connecting to server with username: ${this.currentUsername}...`);

    try {
      this.bot = mineflayer.createBot({
        host: this.config.host,
        port: this.config.port,
        username: this.currentUsername,
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
      this.startPlayerMonitoring();
      this.startFastPlayerDetection(); // Fast detection for immediate exit
      this.startActivity();
    });

    this.bot.on('kicked', (reason) => {
      console.log('❌ Kicked from server:', reason);

      // Check if it's a ban
      const reasonStr = typeof reason === 'object' ? JSON.stringify(reason) : reason.toString();
      const isBanned = reasonStr.includes('banned') || reasonStr.includes('ban') || 
                      reasonStr.includes('multiplayer.disconnect.banned');
      const isThrottled = reasonStr.includes('throttled') || reasonStr.includes('wait before reconnecting');

      if (isBanned) {
        console.log('🚫 Bot was banned! Switching to next username...');
        this.bannedUsernames.add(this.currentUsername);
        this.switchToNextUsername();

        // Connect immediately with new username instead of waiting
        this.connected = false;
        this.status = 'disconnected';
        this.lastError = 'Banned: ' + reasonStr;
        this.stopActivity();

        // Cancel any existing reconnect timeout
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        // Connect immediately with new username
        console.log('🚀 Immediately connecting with new username...');
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.connect();
          }
        }, 1000); // Small 1 second delay to ensure clean disconnect

        return; // Don't call handleDisconnect as we're handling reconnection here
      }

      if (isThrottled) {
        console.log('⏰ Connection throttled! Will wait longer before reconnecting...');
      }

      this.handleDisconnect('Kicked: ' + reasonStr);
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
    this.stopFastPlayerDetection();

    // Keep player monitoring active if hiding from real players
    if (!this.isHidingFromPlayers) {
      this.stopPlayerMonitoring();
      this.scheduleReconnect();
    } else {
      // Keep monitoring active to detect when to return
      console.log('👀 Keeping player monitoring active while hiding...');
    }
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
    if (this.reconnectTimeout || this.isShuttingDown) {
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Check if this is a throttling error and increase delay
    const isThrottled = this.lastError && this.lastError.includes('throttled');
    const delay = isThrottled ? 60000 : 15000; // 60 seconds for throttling, 15 seconds normal

    console.log(`❌ Disconnected, retrying in ${delay/1000} seconds...`);
    this.reconnectTimeout = setTimeout(() => {
      if (!this.isShuttingDown) {
        this.connect();
      }
    }, delay);
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
    this.stopFastPlayerDetection();
  }

  startPlayerMonitoring() {
    if (this.playerCheckInterval) return;

    // Check for real players every 1 minute (60 seconds)
    this.playerCheckInterval = setInterval(() => {
      if (!this.connected || !this.bot) {
        // If hiding from players, check if we should return
        if (this.isHidingFromPlayers) {
          console.log('🔍 Bot is hiding - assuming real players have left after disconnect');
          this.realPlayersOnline.clear();
          this.returnAfterPlayersLeft();
        }
        return;
      }

      try {
        const currentPlayers = new Set();

        // Get all players currently online with more detailed checking
        Object.keys(this.bot.players).forEach(playerName => {
          const player = this.bot.players[playerName];

          // More advanced filtering - exclude bot-like usernames
          const isBotUsername = playerName.startsWith('DARK_WORLD') || 
                              playerName.startsWith('AFK') ||
                              playerName.startsWith('BOT') ||
                              playerName.includes('_BOT') ||
                              /^[A-Z_]+_\d+$/.test(playerName); // Pattern like WORD_NUMBER

          // Only count as real player if they have a valid entity and are actually spawned
          if (!isBotUsername && player && player.entity) {
            currentPlayers.add(playerName);
            console.log(`🔍 Detected real player: ${playerName} (UUID: ${player.uuid})`);
          }
        });

        // Check if any real players joined
        const newPlayers = [...currentPlayers].filter(player => !this.realPlayersOnline.has(player));
        const leftPlayers = [...this.realPlayersOnline].filter(player => !currentPlayers.has(player));

        // Update the real players list
        this.realPlayersOnline = currentPlayers;

        if (newPlayers.length > 0) {
          console.log('👨‍💻 Real player(s) joined:', newPlayers.join(', '));
          console.log('📊 Total real players online:', this.realPlayersOnline.size);
          console.log('🚪 Bot exiting to give space to real players...');
          this.exitForRealPlayers();
        }

        if (leftPlayers.length > 0) {
          console.log('👋 Real player(s) left:', leftPlayers.join(', '));
          console.log('📊 Remaining real players:', this.realPlayersOnline.size);
        }

        // Only return if we're sure no real players are online
        if (this.realPlayersOnline.size === 0 && this.isHidingFromPlayers) {
          console.log('✅ No real players online confirmed, bot can return!');
          this.returnAfterPlayersLeft();
        }

        // Log current player status every 2 minutes when connected  
        if (Date.now() % 120000 < 3000) {
          console.log('📊 Current server status:');
          console.log(`   Real players: ${this.realPlayersOnline.size > 0 ? Array.from(this.realPlayersOnline).join(', ') : 'None'}`);
          console.log(`   Bot hiding: ${this.isHidingFromPlayers}`);
        }

      } catch (error) {
        console.log('⚠ Player monitoring error:', error.message);
      }
    }, 60000); // Check every 1 minute (60 seconds)
  }

  stopPlayerMonitoring() {
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
      this.playerCheckInterval = null;
    }
  }

  startFastPlayerDetection() {
    if (this.fastPlayerCheckInterval) return;

    // Fast detection every 1 second for immediate exit
    this.fastPlayerCheckInterval = setInterval(() => {
      if (!this.connected || !this.bot || this.isHidingFromPlayers) return;

      try {
        // Quick check for real players
        const realPlayers = Object.keys(this.bot.players).filter(playerName => {
          const player = this.bot.players[playerName];
          const isBotUsername = playerName.startsWith('DARK_WORLD') || 
                              playerName.startsWith('AFK') ||
                              playerName.startsWith('BOT') ||
                              playerName.includes('_BOT') ||
                              /^[A-Z_]+_\d+$/.test(playerName);
          
          return !isBotUsername && player && player.entity;
        });

        if (realPlayers.length > 0) {
          console.log('⚡ FAST DETECTION: Real player detected immediately!');
          console.log('🚪 Exiting within 1 second...');
          this.exitForRealPlayers();
        }
      } catch (error) {
        console.log('⚠ Fast detection error:', error.message);
      }
    }, 1000); // Check every 1 second
  }

  stopFastPlayerDetection() {
    if (this.fastPlayerCheckInterval) {
      clearInterval(this.fastPlayerCheckInterval);
      this.fastPlayerCheckInterval = null;
    }
  }

  exitForRealPlayers() {
    if (this.isHidingFromPlayers) return; // Already hiding

    this.isHidingFromPlayers = true;
    this.stopActivity();

    console.log('🔒 Bot entering stealth mode - will monitor server externally');

    // Disconnect immediately but don't set isShuttingDown
    if (this.bot && typeof this.bot.quit === 'function') {
      try {
        this.bot.quit('Real player joined - giving space');
      } catch (error) {
        console.log('⚠ Error quitting for real players:', error.message);
      }
    }

    this.connected = false;
    this.status = 'waiting_for_players_to_leave';

    // Cancel any scheduled reconnects
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Start advanced monitoring - try to reconnect periodically to check players
    this.startAdvancedMonitoring();
  }

  startAdvancedMonitoring() {
    if (this.advancedMonitoringInterval) {
      clearInterval(this.advancedMonitoringInterval);
    }

    let checkAttempts = 0;
    const maxChecks = 20; // Maximum 20 checks (10 minutes total)

    this.advancedMonitoringInterval = setInterval(() => {
      checkAttempts++;
      console.log(`🔍 Advanced monitoring check ${checkAttempts}/${maxChecks} - Waiting ${checkAttempts * 30} seconds`);

      // Wait much longer before assuming players left - 5 minutes minimum
      if (checkAttempts >= 10) { // 10 * 30 seconds = 5 minutes
        console.log('⏰ 5 minutes passed - attempting careful return');
        this.realPlayersOnline.clear();
        this.returnAfterPlayersLeft();
        return;
      }

      // Maximum monitoring time - 10 minutes
      if (checkAttempts >= maxChecks) {
        console.log('⏰ Maximum monitoring time reached (10 minutes) - forcing return');
        this.realPlayersOnline.clear();
        this.returnAfterPlayersLeft();
      }
    }, 30000); // Check every 30 seconds
  }

  stopAdvancedMonitoring() {
    if (this.advancedMonitoringInterval) {
      clearInterval(this.advancedMonitoringInterval);
      this.advancedMonitoringInterval = null;
    }
  }

  returnAfterPlayersLeft() {
    if (!this.isHidingFromPlayers) return; // Not hiding

    this.isHidingFromPlayers = false;
    this.stopAdvancedMonitoring();

    console.log('🤖 All clear! Preparing to return to server with delay...');

    // Add a reasonable delay before reconnecting to avoid throttling
    setTimeout(() => {
      if (!this.isShuttingDown && !this.connected && !this.isHidingFromPlayers) {
        console.log('🔄 Now attempting to reconnect after player monitoring...');
        this.connect();
      } else {
        console.log('🚫 Reconnection cancelled - bot state changed');
      }
    }, 10000); // 10 second delay to prevent rapid reconnections
  }

  switchToNextUsername() {
    // Keep trying next usernames until we find one that's not banned
    do {
      this.usernameCounter++;
      this.currentUsername = `${this.baseUsername}_${this.usernameCounter}`;
    } while (this.bannedUsernames.has(this.currentUsername));

    console.log(`🔄 Switched to new username: ${this.currentUsername}`);
  }

  getStatus() {
    return {
      connected: this.connected,
      status: this.status,
      lastError: this.lastError,
      username: this.currentUsername,
      server: `${this.config.host}:${this.config.port}`,
      bannedUsernames: Array.from(this.bannedUsernames),
      usernameCounter: this.usernameCounter,
      realPlayersOnline: Array.from(this.realPlayersOnline),
      isHidingFromPlayers: this.isHidingFromPlayers
    };
  }

  disconnect() {
    this.isShuttingDown = true;
    this.stopActivity();
    this.stopPlayerMonitoring();
    this.stopFastPlayerDetection();
    this.stopAdvancedMonitoring();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.bot && typeof this.bot.quit === 'function') {
      try {
        this.bot.quit();
      } catch (error) {
        console.log('⚠ Error quitting bot:', error.message);
      }
      this.bot = null;
    }
    this.connected = false;
    this.status = 'disconnected';
  }
}

module.exports = MinecraftBot;
