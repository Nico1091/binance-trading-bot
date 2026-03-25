/*
 * platforms.js
 * Unified platform manager and adapters for Binance (live/testnet) and MT5 (stub/optional)
 */

const { Spot } = require('@binance/connector');
const axios = require('axios');

class Metrics {
  constructor() {
    this.reset();
  }
  reset() {
    this.calls = 0;
    this.failures = 0;
    this.avgLatencyMs = 0;
    this.lastLatencyMs = 0;
    this.lastError = null;
    this.lastOkAt = 0;
    this.lastFailAt = 0;
  }
  record(latencyMs, ok, err) {
    this.calls += 1;
    this.lastLatencyMs = latencyMs;
    // Exponential moving average for latency
    this.avgLatencyMs = this.avgLatencyMs === 0 ? latencyMs : (this.avgLatencyMs * 0.9 + latencyMs * 0.1);
    if (ok) this.lastOkAt = Date.now();
    if (!ok) {
      this.failures += 1;
      this.lastFailAt = Date.now();
      this.lastError = err ? String(err.message || err) : 'Unknown error';
    }
  }
  snapshot() {
    return {
      calls: this.calls,
      failures: this.failures,
      avgLatencyMs: Number(this.avgLatencyMs.toFixed(2)),
      lastLatencyMs: this.lastLatencyMs,
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      lastFailAt: this.lastFailAt
    };
  }
}

class PlatformManager {
  constructor(opts = {}) {
    this.logger = opts.logger || (() => {});
    this.platform = opts.platform || 'binance_live'; // 'binance_live' | 'binance_testnet' | 'mt5'
    this.binance = {
      apiKey: opts.apiKey || process.env.BINANCE_API_KEY || '',
      apiSecret: opts.apiSecret || process.env.BINANCE_API_SECRET || '',
      baseURL: this.platform === 'binance_testnet' ? 'https://testnet.binance.vision' : undefined
    };
    this.mt5 = {
      enabled: false,
      // For real MT5 integration, provide a bridge or MetaApi credentials
      token: process.env.METAAPI_TOKEN || '',
      accountId: process.env.METAAPI_ACCOUNT_ID || '',
      server: process.env.MT5_SERVER || '',
      login: process.env.MT5_LOGIN || '',
      password: process.env.MT5_PASSWORD || ''
    };
    this.metrics = new Metrics();
    this._client = null;
    this.timeOffset = 0; // Cache de offset de tiempo
    this.lastTimeSync = 0; // Última sincronización
    this.timeSyncInterval = 60000; // Sincronizar cada minuto

    this._rebuildClient();
  }

  setPlatform(platform) {
    const allowed = ['binance_live', 'binance_testnet', 'mt5'];
    if (!allowed.includes(platform)) throw new Error(`Invalid platform: ${platform}`);
    this.platform = platform;
    // Adjust baseURL for binance
    if (platform.startsWith('binance')) {
      this.binance.baseURL = platform === 'binance_testnet' ? 'https://testnet.binance.vision' : undefined;
    }
    this._rebuildClient();
  }

  setBinanceKeys({ apiKey, apiSecret }) {
    if (typeof apiKey === 'string') this.binance.apiKey = apiKey.trim();
    if (typeof apiSecret === 'string') this.binance.apiSecret = apiSecret.trim();
    if (this.platform.startsWith('binance')) this._rebuildClient();
  }

  setMT5Config(cfg = {}) {
    Object.assign(this.mt5, cfg);
    if (this.platform === 'mt5') this._rebuildClient();
  }

  getClient() {
    return this._client;
  }

  getStatus() {
    return {
      platform: this.platform,
      binanceConfigured: Boolean(this.binance.apiKey && this.binance.apiSecret),
      mt5Configured: Boolean(this.mt5.enabled && (this.mt5.token || (this.mt5.login && this.mt5.password))),
      metrics: this.metrics.snapshot()
    };
  }

  async withRetry(fn, name = 'apiCall', maxRetries = 5, baseDelayMs = 250) {
    const start = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        // Sincronizar tiempo si es necesario
        await this.ensureTimeSync();
        
        const result = await fn();
        const latency = Date.now() - start;
        this.metrics.record(latency, true);
        return result;
      } catch (err) {
        attempt += 1;
        const latency = Date.now() - start;
        this.metrics.record(latency, false, err);
        
        if (attempt > maxRetries) {
          this.logger(`❌ Máximo de reintentos alcanzado para ${name}: ${err?.response?.data?.msg || err.message || err}`);
          throw err;
        }
        
        // Si es error de timestamp, forzar resincronización
        const isTimestampError = err?.response?.data?.code === -1021;
        if (isTimestampError) {
          this.logger(`🔄 Error de timestamp detectado, forzando resincronización...`);
          this.timeOffset = 0;
          this.lastTimeSync = 0;
          await this.ensureTimeSync();
        }
        
        // Calcular delay con backoff exponencial
        const delay = isTimestampError ? 2000 : baseDelayMs * Math.pow(2, attempt - 1);
        
        this.logger(`Retrying ${name} ${isTimestampError ? '(timestamp error)' : ''} after error: ${err?.response?.data?.msg || err.message || err} (attempt ${attempt}/${maxRetries})`);
        
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  async ensureTimeSync() {
    const now = Date.now();
    
    // Si no tenemos offset o es antiguo, resincronizar
    if (this.timeOffset === 0 || (now - this.lastTimeSync) > this.timeSyncInterval) {
      await this.syncTime();
    }
  }
  
  async syncTime() {
    try {
      const timeUrl = this.binance.baseURL ? 
        `${this.binance.baseURL.replace('/api', '')}/api/v3/time` :
        'https://api.binance.com/api/v3/time';
      
      // Hacer múltiples peticiones para obtener un promedio más preciso
      const responses = await Promise.all([
        axios.get(timeUrl, { timeout: 3000 }),
        axios.get(timeUrl, { timeout: 3000 }),
        axios.get(timeUrl, { timeout: 3000 })
      ]);
      
      const serverTimes = responses.map(r => r.data.serverTime);
      const avgServerTime = serverTimes.reduce((a, b) => a + b, 0) / serverTimes.length;
      const localTime = Date.now();
      const offset = avgServerTime - localTime;
      
      this.timeOffset = Math.round(offset);
      this.lastTimeSync = localTime;
      
      if (Math.abs(this.timeOffset) > 1000) {
        this.logger(`⏰ Tiempo sincronizado: offset ${this.timeOffset}ms`);
      } else {
        this.logger(`⏰ Tiempo sincronizado: offset ${this.timeOffset}ms (preciso)`);
      }
      
      return this.timeOffset;
    } catch (err) {
      this.logger(`❌ Error sincronizando tiempo: ${err.message}`);
      // Mantener el offset anterior si existe
      return this.timeOffset;
    }
  }

  async getTimeOffset() {
    await this.ensureTimeSync();
    return this.timeOffset;
  }

  _rebuildClient() {
    this.metrics.reset();
    if (this.platform === 'mt5') {
      this._client = this._createMT5Stub();
    } else {
      this._client = this._createBinanceClient();
    }
    this.logger(`Platform client initialized: ${this.platform}`);
  }

  _createBinanceClient() {
    const { apiKey, apiSecret, baseURL } = this.binance;
    
    // Configuración robusta con sincronización de tiempo personalizada
    const clientConfig = baseURL ? { 
      baseURL,
      timeout: 30000,
      recvWindow: 120000, // 120 segundos para manejar desfases extremos
      disableTimeSync: true, // Deshabilitar sincronización automática del conector
      headers: {
        'User-Agent': 'trading-bot/1.0'
      }
    } : {
      timeout: 30000,
      recvWindow: 120000, // 120 segundos
      disableTimeSync: true,
      headers: {
        'User-Agent': 'trading-bot/1.0'
      }
    };
    
    const spot = new Spot(apiKey || '', apiSecret || '', clientConfig);
    
    // Solución simple: aumentar recvWindow y sincronizar antes de cada llamada
    // El offset se aplicará automáticamente en ensureTimeSync()
    
    const wrap = (name, fn) => async (...args) => {
      await this.ensureTimeSync();
      return this.withRetry(() => fn(...args), name);
    };

    return {
      exchangeInfo: wrap('exchangeInfo', () => spot.exchangeInfo()),
      account: wrap('account', () => spot.account()),
      openOrders: wrap('openOrders', () => spot.openOrders()),
      tickerPrice: wrap('tickerPrice', (symbol) => spot.tickerPrice(symbol)),
      klines: wrap('klines', (symbol, interval, opts) => spot.klines(symbol, interval, opts)),
      newOrder: wrap('newOrder', (symbol, side, type, params) => spot.newOrder(symbol, side, type, params)),
      cancelOrder: wrap('cancelOrder', (symbol, params) => spot.cancelOrder(symbol, params)),
      getOrder: wrap('getOrder', (symbol, params) => spot.getOrder(symbol, params))
    };
  }

  
  _createMT5Stub() {
    const explain = (method) => {
      const msg = `MT5 adapter: method ${method} not implemented. Configure an MT5 bridge or MetaApi credentials.`;
      const err = new Error(msg);
      // eslint-disable-next-line no-console
      this.logger(`MT5 STUB -> ${msg}`);
      throw err;
    };
    const wrap = (name) => () => this.withRetry(() => Promise.reject(explain(name)), name);

    return {
      exchangeInfo: wrap('exchangeInfo'),
      account: wrap('account'),
      openOrders: wrap('openOrders'),
      tickerPrice: wrap('tickerPrice'),
      klines: wrap('klines'),
      newOrder: wrap('newOrder'),
      cancelOrder: wrap('cancelOrder'),
      getOrder: wrap('getOrder')
    };
  }
}

module.exports = { PlatformManager };
