const axios = require('axios');
const fs = require('fs');
const readline = require('readline');
const winston = require('winston');
const HttpsProxyAgent = require('https-proxy-agent');
const crypto = require('crypto');

// Setup logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'bot.log' }),
    new winston.transports.Console()
  ]
});

class GradientBot {
  constructor() {
    this.accounts = [];
    this.proxies = [];
    this.currentMode = '';
    this.sessions = new Map();
    this.runningInstances = new Map();
  }

  generateDeviceId() {
    return crypto.randomBytes(16).toString('hex');
  }

  async init() {
    try {
      if (!fs.existsSync('./accounts.txt')) {
        throw new Error('accounts.txt tidak ditemukan!');
      }
      
      this.accounts = fs.readFileSync('./accounts.txt', 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [username, password] = line.trim().split(':');
          return { 
            username, 
            password,
            deviceId: this.generateDeviceId()
          };
        });

      if (fs.existsSync('./proxy.txt')) {
        this.proxies = fs.readFileSync('./proxy.txt', 'utf8')
          .split('\n')
          .filter(Boolean);
      }

      await this.selectMode();
    } catch (error) {
      logger.error(`Inisialisasi error: ${error.message}`);
    }
  }

  async selectMode() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question('Pilih mode:\n1. Koneksi Langsung\n2. Mode Proxy\nPilihan (1/2): ', async (answer) => {
        this.currentMode = answer.trim() === '2' ? 'proxy' : 'direct';
        rl.close();
        await this.startMultipleInstances();
        resolve();
      });
    });
  }

  async login(account, proxy = null) {
    try {
      const config = {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `GradientNetwork/${account.deviceId}`,
          'X-Device-ID': account.deviceId
        },
        timeout: 30000
      };

      if (proxy) {
        const [host, port, username, password] = proxy.split(':');
        const httpsAgent = new HttpsProxyAgent(`http://${username}:${password}@${host}:${port}`);
        config.httpsAgent = httpsAgent;
        config.proxy = false;
      }

      const response = await axios.post('https://app.gradient.network/api/auth/login', {
        username: account.username,
        password: account.password,
        device_id: account.deviceId
      }, config);

      logger.info(`Login berhasil: ${account.username}`);
      return {
        ...response.data,
        username: account.username,
        deviceId: account.deviceId
      };
    } catch (error) {
      logger.error(`Login gagal untuk ${account.username}: ${error.message}`);
      return null;
    }
  }

  async pingNode(session, proxy = null) {
    try {
      const config = {
        headers: {
          'Authorization': `Bearer ${session.token}`,
          'Content-Type': 'application/json',
          'X-Device-ID': session.deviceId
        }
      };

      if (proxy) {
        const [host, port, username, password] = proxy.split(':');
        const httpsAgent = new HttpsProxyAgent(`http://${username}:${password}@${host}:${port}`);
        config.httpsAgent = httpsAgent;
      }

      await axios.post('https://app.gradient.network/api/node/heartbeat', {
        device_id: session.deviceId,
        status: 'active'
      }, config);

      logger.info(`Ping berhasil: ${session.username}`);
      return true;
    } catch (error) {
      logger.error(`Ping gagal untuk ${session.username}: ${error.message}`);
      return false;
    }
  }

  async runInstance(account, proxy = null) {
    try {
      const session = await this.login(account, proxy);
      if (!session) {
        throw new Error('Login gagal');
      }

      this.sessions.set(account.username, session);
      
      // Setup interval ping
      const pingInterval = setInterval(async () => {
        const success = await this.pingNode(session, proxy);
        if (!success) {
          // Coba login ulang jika ping gagal
          const newSession = await this.login(account, proxy);
          if (newSession) {
            this.sessions.set(account.username, newSession);
          }
        }
      }, 3 * 60 * 1000); // Ping setiap 3 menit

      this.runningInstances.set(account.username, pingInterval);
      
      logger.info(`Instance berjalan untuk: ${account.username}`);
    } catch (error) {
      logger.error(`Instance gagal untuk ${account.username}: ${error.message}`);
    }
  }

  async startMultipleInstances() {
    try {
      const totalInstances = this.accounts.length;
      logger.info(`Memulai ${totalInstances} instances...`);

      for (let i = 0; i < totalInstances; i++) {
        const account = this.accounts[i];
        const proxy = this.currentMode === 'proxy' ? this.proxies[i % this.proxies.length] : null;
        
        // Delay antara setiap instance untuk menghindari rate limiting
        await new Promise(resolve => setTimeout(resolve, 5000));
        await this.runInstance(account, proxy);
      }
    } catch (error) {
      logger.error(`Error menjalankan multiple instances: ${error.message}`);
    }
  }
}

// Start bot
const bot = new GradientBot();
bot.init().catch(error => {
  logger.error(`Bot gagal dimulai: ${error.message}`);
});
