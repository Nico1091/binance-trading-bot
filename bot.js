/**
 * bot.js
 * Binance Testnet Dashboard + AutoTrader (extenso y robusto)
 *
 * Características:
 * - Endpoints: /estado, /klines, /orden, /autotrade/start, /autotrade/stop, /status, /config, /backtest, /orders/cancel
 * - Estrategias: EMA crossover (50/200) + RSI + MACD + ATR-based SL/TP + optional Bollinger breakout confirmation
 * - Gestión: rounding por tick/step, minNotional check, persistence en SQLite
 * - Logging a fichero, backtest simple con slippage/comisión, protección contra solapamiento
 *
 * Recomendado: usar variables de entorno para API Key/Secret:
 *  export BINANCE_API_KEY='xxx'
 *  export BINANCE_API_SECRET='yyy'
 *
 * Luego: node bot.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { PlatformManager } = require('./platforms');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// ---------- CONFIG (edítalas o establece variables de entorno) ----------
const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

// Default trading symbol
const DEFAULT_SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const TESTNET_BASEURL = 'https://testnet.binance.vision';

// File paths
const DB_PATH = path.join(__dirname, 'trader.sqlite');
const LOG_PATH = path.join(__dirname, 'trader.log');

// Create log file if not exists
if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '', { encoding: 'utf8' });

// Logger util
let clients = [];
function logFile(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_PATH, line);
  // Also send to frontend via SSE
  pushLog(msg);
}

// Express & Binance client
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'carpeta')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'carpeta', 'index.html'));
});

let platformManager = new PlatformManager({ logger: logFile, platform: 'binance_live', apiKey: API_KEY, apiSecret: API_SECRET });
let client = platformManager.getClient();

// Inicializar claves desde variables de entorno si existen
if (API_KEY && API_SECRET) {
  logFile('🔑 Claves API cargadas desde variables de entorno');
  platformManager.setBinanceKeys({ apiKey: API_KEY, apiSecret: API_SECRET });
  
  // Sincronizar tiempo inicialmente
  logFile('⏰ Sincronizando tiempo con servidores Binance...');
  platformManager.syncTime().then(offset => {
    logFile(`⏰ Tiempo sincronizado: offset ${offset}ms`);
  }).catch(err => {
    logFile(`❌ Error inicial sincronizando tiempo: ${err.message}`);
  });
} else {
  logFile('⚠️ No se encontraron claves API en variables de entorno');
}
function refreshClientAndCaches() {
  exchangeInfoCache = null;
  exchangeInfoCacheAt = 0;
  symbolFiltersCache.clear();
  client = platformManager.getClient();
  logFile(`Platform client ready: ${platformManager.platform}`);
}
function platformStatus() {
  try { return platformManager.getStatus(); }
  catch (e) { return { platform: 'unknown', binanceConfigured: false, mt5Configured: false, metrics: {} }; }
}
function isSignedApiAvailable() {
  const p = platformStatus();
  return String(p.platform || '').startsWith('binance') && p.binanceConfigured;
}

// ---------- In-memory caches and runtime state ----------
let db; // sqlite handle
let AUTO_TRADE = false; // Desactivado por defecto - activar desde dashboard
let isEvaluating = false;
let exchangeInfoCache = null;
let exchangeInfoCacheAt = 0;
const EXCHANGE_INFO_TTL = 1000 * 60 * 5; // 5 min
const symbolFiltersCache = new Map();
let openPositions = []; // mirrors DB current open positions

// Nuevas variables de seguimiento
let dailyStats = {
  trades: 0,
  profit: 0,
  startBalance: 0,
  lastReset: new Date().toDateString(),
  peakProfit: 0, // Máxima ganancia alcanzada
  lastTradeTime: 0 // Timestamp del último trade
};
let tradeHistory = []; // Historial de trades para análisis
let marketConditions = {
  trend: 'NEUTRAL', // BULLISH, BEARISH, NEUTRAL
  volatility: 'MEDIUM', // LOW, MEDIUM, HIGH
  volume: 'NORMAL' // LOW, NORMAL, HIGH
};
let tradingMode = 'ACTIVE'; // ACTIVE, MONITOR_ONLY, PAUSED

// Default strategy config (editable via /config)
const defaultConfig = {
  SYMBOL: DEFAULT_SYMBOL,
  INTERVAL: '1m',
  RISK_PERCENT: 0.08, // 8% of USDT balance per trade (más agresivo pero controlado)
  ATR_MULTIPLIER: 2.0, // Stop loss más amplio para evitar salidas prematuras
  TAKE_PROFIT_MULTIPLIER: 3.0, // TP más ambicioso pero realista
  MIN_USDT_TO_TRADE: 5, // Mínimo más bajo para más oportunidades
  AUTO_INTERVAL_SEC: 15, // Evaluación más frecuente
  MAX_OPEN_POSITIONS: 5, // Permitir más posiciones concurrentes
  COMMISSION_PCT: 0.001, // 0.1% per trade (approx)
  SLIPPAGE_PCT: 0.001, // simulate 0.1% slippage in backtests
  
  // Control de gestión de posiciones
  MAX_HOLD_TIME_MS: 1000 * 60 * 60, // 1 hora
  EARLY_EXIT_ENABLE: false, // Desactivar salidas tempranas por defecto
  MIN_HOLD_TIME_MS: 300000, // 5 minutos de retención mínima
  EARLY_EXIT_MIN_PROFIT: 0.003, // 0.3% si la ganancia es menor, requerir fuerte confirmación bajista
  EARLY_EXIT_MAX_LOSS: -0.01, // -1% permite salida temprana si se confirma debilidad
  TRAILING_STOP_ENABLE: true,
  TRAILING_STOP_ATR_MULT: 0.5, // nuevo SL = precio actual - ATR*0.5 si supera entrada + ATR
  
  // Nuevas configuraciones avanzadas
  ENABLE_SCALPING: true, // Trading de alta frecuencia
  ENABLE_SWING_TRADING: true, // Trading de swing
  ENABLE_BREAKOUT_TRADING: true, // Trading de rupturas
  ENABLE_MOMENTUM_TRADING: true, // Trading de momentum
  ENABLE_MEAN_REVERSION: true, // Trading de reversión a la media
  ENABLE_TREND_FOLLOWING: true, // Trading de seguimiento de tendencia
  
  // Umbrales más agresivos para más señales
  VOLUME_THRESHOLD: 1.1, // Requerir volumen un poco más alto para mayor confianza
  RSI_OVERSOLD: 25, // RSI sobreventa más estricto (mayor confianza)
  RSI_OVERBOUGHT: 75, // RSI sobrecompra más estricto (mayor confianza)
  RSI_NEUTRAL_LOW: 45, // RSI bajo neutral
  RSI_NEUTRAL_HIGH: 55, // RSI alto neutral
  MACD_SIGNAL_THRESHOLD: 0.00001, // Umbral mínimo para señal MACD (más permisivo)
  BOLLINGER_PERIOD: 20, // Período para Bollinger Bands
  BOLLINGER_STD: 2, // Desviación estándar para Bollinger
  TREND_CONFIRMATION_CANDLES: 2, // Velas para confirmar tendencia (menos estricto)
  MAX_DAILY_TRADES: 150, // Más oportunidades diarias
  PROFIT_TARGET_DAILY: 0.25, // Objetivo de ganancia diaria más ambicioso (25%)
  MAX_DRAWDOWN: 0.20, // Máxima pérdida permitida (20%)
  
  // Nuevos parámetros para estrategias adicionales
  MOMENTUM_PERIOD: 10, // Período para momentum
  MEAN_REVERSION_PERIOD: 14, // Período para reversión a la media
  TREND_PERIOD: 20, // Período para seguimiento de tendencia
  VOLATILITY_THRESHOLD: 0.01, // Umbral de volatilidad (1%)
  PRICE_CHANGE_THRESHOLD: 0.005 // Umbral de cambio de precio (0.5%)
};

// runtime config (will be loaded/saved from DB)
let config = { ...defaultConfig };

// ---------- DB initialization ----------
async function initDB() {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT,
      qty REAL,
      entryPrice REAL,
      stopLoss REAL,
      takeProfit REAL,
      openedAt INTEGER,
      closedAt INTEGER,
      closedPrice REAL,
      side TEXT,
      note TEXT
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS trade_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      symbol TEXT,
      side TEXT,
      qty REAL,
      price REAL,
      type TEXT,
      info TEXT
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Load saved config (if any)
  const rows = await db.all(`SELECT key, value FROM config`);
  for (const r of rows) {
    try {
      config[r.key] = JSON.parse(r.value);
    } catch (e) {
      config[r.key] = r.value;
    }
  }
  logFile('DB initialized and config loaded');
}

// ---------- Exchange Info & Filters helpers ----------
async function getExchangeInfo() {
  const now = Date.now();
  if (exchangeInfoCache && (now - exchangeInfoCacheAt < EXCHANGE_INFO_TTL)) {
    return exchangeInfoCache;
  }
  const info = await client.exchangeInfo();
  exchangeInfoCache = info.data;
  exchangeInfoCacheAt = now;
  logFile('Fetched exchangeInfo (refreshed cache)');
  return exchangeInfoCache;
}

async function getSymbolFilters(symbol) {
  if (symbolFiltersCache.has(symbol)) return symbolFiltersCache.get(symbol);
  const info = await getExchangeInfo();
  const s = (info.symbols || []).find(x => x.symbol === symbol);
  if (!s) throw new Error(`Symbol ${symbol} not found in exchangeInfo`);
  const filters = {};
  filters.quotePrecision = s.quotePrecision || s.quoteAssetPrecision || 2;
  for (const f of s.filters) {
    if (f.filterType === 'LOT_SIZE') filters.stepSize = parseFloat(f.stepSize);
    if (f.filterType === 'PRICE_FILTER') filters.tickSize = parseFloat(f.tickSize);
    if (f.filterType === 'MIN_NOTIONAL') filters.minNotional = parseFloat(f.minNotional);
  }
  symbolFiltersCache.set(symbol, filters);
  return filters;
}

function roundDownToStep(value, step) {
  if (!step || step === 0) return value;
  // Calcular el número de decimales necesarios
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const inv = Math.pow(10, decimals);
  return Math.floor(value * inv) / inv;
}

function roundToTick(value, tick) {
  if (!tick || tick === 0) return value;
  // Calcular el número de decimales necesarios
  const decimals = Math.max(0, -Math.floor(Math.log10(tick)));
  const inv = Math.pow(10, decimals);
  return Math.round(value * inv) / inv;
}

// Nueva función para formatear cantidades según los filtros del símbolo
function formatQuantity(value, stepSize) {
  if (!stepSize || stepSize === 0) return value.toString();
  const decimals = Math.max(0, -Math.floor(Math.log10(stepSize)));
  return parseFloat(value).toFixed(decimals);
}

function formatPrice(value, tickSize) {
  if (!tickSize || tickSize === 0) return value.toString();
  const decimals = Math.max(0, -Math.floor(Math.log10(tickSize)));
  return parseFloat(value).toFixed(decimals);
}

// ---------- Indicator functions ----------
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}
function emaArray(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) {
      const s = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      prev = s;
      out.push(prev);
      continue;
    }
    prev = (v - prev) * k + prev;
    out.push(prev);
  }
  return out;
}
function calcRSI(values, period = 14) {
  if (values.length < period + 1) return null;
  const deltas = [];
  for (let i = 1; i < values.length; i++) deltas.push(values[i] - values[i - 1]);
  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i];
    if (d >= 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  let rs = avgGain / (avgLoss || 1e-9);
  let rsi = 100 - (100 / (1 + rs));
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? Math.abs(d) : 0;
    avgGain = ((avgGain * (period - 1)) + g) / period;
    avgLoss = ((avgLoss * (period - 1)) + l) / period;
    rs = avgGain / (avgLoss || 1e-9);
    rsi = 100 - (100 / (1 + rs));
  }
  return rsi;
}
function calcMACD(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal) return null;
  const emaFast = emaArray(values, fast);
  const emaSlow = emaArray(values, slow);
  const macdLine = [];
  for (let i = 0; i < values.length; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    macdLine.push((f === null || s === null) ? null : (f - s));
  }
  const macdClean = macdLine.filter(x => x !== null);
  if (macdClean.length < signal) return null;
  const signalArr = emaArray(macdClean, signal);
  const macdLatest = macdClean[macdClean.length - 1];
  const signalLatest = signalArr[signalArr.length - 1];
  const hist = macdLatest - (signalLatest || 0);
  return { macd: macdLatest, signal: signalLatest, hist };
}
function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const cur = klines[i];
    const prev = klines[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  const slice = trs.slice(trs.length - period);
  const atr = slice.reduce((a, b) => a + b, 0) / period;
  return atr;
}
function calcBollinger(values, period = 20, stdMul = 2) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const ma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - ma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { ma, upper: ma + stdMul * std, lower: ma - stdMul * std, std };
}

// Nuevos indicadores técnicos avanzados
function calcStochastic(klines, kPeriod = 14, dPeriod = 3) {
  if (klines.length < kPeriod) return null;
  const recent = klines.slice(-kPeriod);
  const current = recent[recent.length - 1];
  const highestHigh = Math.max(...recent.map(k => k.high));
  const lowestLow = Math.min(...recent.map(k => k.low));
  const k = ((current.close - lowestLow) / (highestHigh - lowestLow)) * 100;
  return { k, d: k }; // Simplificado para esta implementación
}

function calcWilliamsR(klines, period = 14) {
  if (klines.length < period) return null;
  const recent = klines.slice(-period);
  const current = recent[recent.length - 1];
  const highestHigh = Math.max(...recent.map(k => k.high));
  const lowestLow = Math.min(...recent.map(k => k.low));
  return ((highestHigh - current.close) / (highestHigh - lowestLow)) * -100;
}

function calcVolumeProfile(klines, period = 20) {
  if (klines.length < period) return null;
  const recent = klines.slice(-period);
  const avgVolume = recent.reduce((sum, k) => sum + k.volume, 0) / period;
  const currentVolume = klines[klines.length - 1].volume;
  return {
    avgVolume,
    currentVolume,
    volumeRatio: currentVolume / avgVolume,
    isHighVolume: currentVolume > avgVolume * 1.5
  };
}

function calcSupportResistance(klines, period = 20) {
  if (klines.length < period) return null;
  const recent = klines.slice(-period);
  const highs = recent.map(k => k.high);
  const lows = recent.map(k => k.low);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const currentPrice = klines[klines.length - 1].close;
  
  return {
    resistance,
    support,
    currentPrice,
    nearResistance: currentPrice > resistance * 0.98,
    nearSupport: currentPrice < support * 1.02
  };
}

function calcTrendStrength(klines, period = 20) {
  if (klines.length < period) return null;
  const recent = klines.slice(-period);
  let bullishCandles = 0;
  let bearishCandles = 0;
  
  recent.forEach(k => {
    if (k.close > k.open) bullishCandles++;
    else if (k.close < k.open) bearishCandles++;
  });
  
  const trendRatio = bullishCandles / (bullishCandles + bearishCandles);
  
  return {
    trendRatio,
    strength: trendRatio > 0.6 ? 'BULLISH' : trendRatio < 0.4 ? 'BEARISH' : 'NEUTRAL',
    confidence: Math.abs(trendRatio - 0.5) * 2
  };
}

// ---------- Order helpers ----------
async function safeNewOrder(symbol, side, type, params) {
  // wrapper to log and handle errors
  try {
    const resp = await client.newOrder(symbol, side, type, params);
    logFile(`ORDER OK: ${side} ${symbol} ${JSON.stringify(params)} -> ${JSON.stringify(resp.data)}`);
    return resp.data;
  } catch (err) {
    const errorData = err?.response?.data;
    if (errorData && errorData.code === -2010) {
        logFile(`PREVENTIVE WARNING: Insufficient balance to place order. ${JSON.stringify(params)}`);
        return null; // No lanzar error, solo advertir
    }
    const msg = errorData || err.message || err;
    logFile(`ORDER ERROR: ${side} ${symbol} ${JSON.stringify(params)} -> ${JSON.stringify(msg)}`);
    throw err;
  }
}
async function marketBuyByQuote(symbol, quoteAmount) {
  // uses quoteOrderQty param for market buy by quote (supported in Spot)
  const filters = await getSymbolFilters(symbol);
  const precision = filters.quotePrecision || 2;
  const formattedAmount = parseFloat(quoteAmount).toFixed(precision);
  const params = { quoteOrderQty: formattedAmount };
  return safeNewOrder(symbol, 'BUY', 'MARKET', params);
}

async function marketSellByQty(symbol, quantity) {
  const filters = await getSymbolFilters(symbol);
  const formattedQty = formatQuantity(quantity, filters.stepSize || 0.00001);
  const params = { quantity: formattedQty };
  return safeNewOrder(symbol, 'SELL', 'MARKET', params);
}

// Nueva función para órdenes limit con mejor precisión
async function limitOrder(symbol, side, quantity, price) {
  const filters = await getSymbolFilters(symbol);
  const formattedQty = formatQuantity(quantity, filters.stepSize || 0.00001);
  const formattedPrice = formatPrice(price, filters.tickSize || 0.01);
  
  // Verificar minNotional
  const notional = parseFloat(formattedQty) * parseFloat(formattedPrice);
  if (filters.minNotional && notional < filters.minNotional) {
    throw new Error(`Order value ${notional} below minimum notional ${filters.minNotional}`);
  }
  
  const params = { 
    quantity: formattedQty, 
    price: formattedPrice,
    timeInForce: 'GTC'
  };
  return safeNewOrder(symbol, side, 'LIMIT', params);
}

// ---------- Persistence helpers ----------
async function savePositionToDB(p) {
  const stmt = await db.run(
    `INSERT INTO positions (symbol, qty, entryPrice, stopLoss, takeProfit, openedAt, side, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    p.symbol, p.qty, p.entryPrice, p.stopLoss, p.takeProfit, p.openedAt, p.side, p.note || ''
  );
  return stmt.lastID;
}
async function closePositionInDB(id, closedAt, closedPrice) {
  await db.run(`UPDATE positions SET closedAt=?, closedPrice=? WHERE id=?`, closedAt, closedPrice, id);
}
async function updatePositionSLTPInDB(id, stopLoss, takeProfit) {
  await db.run(`UPDATE positions SET stopLoss=?, takeProfit=? WHERE id=?`, stopLoss, takeProfit, id);
}
async function logTradeToDB(entry) {
  await db.run(`INSERT INTO trade_logs (ts, symbol, side, qty, price, type, info) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    Date.now(), entry.symbol, entry.side, entry.qty, entry.price, entry.type || 'AUTO', entry.info || '');
}

// ---------- Utility functions ----------
async function getBalancesFiltered(minNonZero = true) {
  if (!isSignedApiAvailable()) return [];
  try {
    const resp = await client.account();
    const balances = resp.data.balances || [];
    const filtered = balances.filter(b => {
      const free = parseFloat(b.free || 0);
      const locked = parseFloat(b.locked || 0);
      return minNonZero ? (free > 0 || locked > 0) : true;
    });
    return filtered;
  } catch (err) {
    logFile(`❌ Error obteniendo balances: ${err?.response?.data?.msg || err.message || err}`);
    return [];
  }
}
async function getFreeBalance(asset) {
  if (!isSignedApiAvailable()) return 0;
  const balances = await getBalancesFiltered(false);
  const b = balances.find(x => x.asset === asset);
  return b ? parseFloat(b.free) : 0;
}

// ---------- Risk Management & Statistics ----------
function resetDailyStats() {
  const today = new Date().toDateString();
  if (dailyStats.lastReset !== today) {
    dailyStats.trades = 0;
    dailyStats.profit = 0;
    dailyStats.startBalance = 0;
    dailyStats.lastReset = today;
    logFile('📊 Estadísticas diarias reiniciadas');
  }
}

async function updateDailyStats() {
  resetDailyStats();
  if (!isSignedApiAvailable()) {
    logFile('⚠️ Sin credenciales configuradas - usando estadísticas simuladas');
    return;
  }
  try {
    const usdtBalance = await getFreeBalance('USDT');
    if (dailyStats.startBalance === 0) {
      dailyStats.startBalance = usdtBalance;
    }
    dailyStats.profit = usdtBalance - dailyStats.startBalance;
    
    // Actualizar pico de ganancia
    if (dailyStats.profit > dailyStats.peakProfit) {
      dailyStats.peakProfit = dailyStats.profit;
    }
  } catch (err) {
    logFile(`❌ Error actualizando estadísticas: ${err?.response?.data?.msg || err.message || err}`);
  }
}

function checkRiskLimits() {
  // Verificar límites de riesgo
  const dailyProfitPct = dailyStats.profit / dailyStats.startBalance;
  const maxTradesReached = dailyStats.trades >= config.MAX_DAILY_TRADES;
  const profitTargetReached = dailyProfitPct >= config.PROFIT_TARGET_DAILY;
  const maxDrawdownReached = dailyProfitPct <= -config.MAX_DRAWDOWN;
  
  // Verificar si podemos reanudar trading después de una pausa
  const canResumeTrading = checkIfCanResumeTrading();
  
  if (maxTradesReached) {
    if (canResumeTrading) {
      logFile(`⚠️ Límite diario de trades alcanzado: ${dailyStats.trades}/${config.MAX_DAILY_TRADES} - Solo monitoreando`);
      return 'MONITOR_ONLY'; // Solo monitorear, no hacer trades
    } else {
      return 'MONITOR_ONLY';
    }
  }
  
  if (profitTargetReached) {
    if (canResumeTrading) {
      logFile(`🎯 Objetivo de ganancia diaria alcanzado: ${(dailyProfitPct * 100).toFixed(2)}% - Continuando monitoreo`);
      return 'MONITOR_ONLY'; // Solo monitorear, no hacer trades
    } else {
      return 'MONITOR_ONLY';
    }
  }
  
  if (maxDrawdownReached) {
    logFile(`🚨 Máxima pérdida permitida alcanzada: ${(dailyProfitPct * 100).toFixed(2)}% - Pausa completa`);
    return false; // Pausa completa solo en pérdidas extremas
  }
  
  return true; // Trading normal
}

// Función para verificar si podemos reanudar el trading
function checkIfCanResumeTrading() {
  const now = Date.now();
  const timeSinceLastTrade = now - dailyStats.lastTradeTime;
  const dailyProfitPct = dailyStats.profit / dailyStats.startBalance;
  
  // Condiciones para reanudar trading:
  // 1. Han pasado al menos 30 minutos desde el último trade
  // 2. Las ganancias han bajado al menos 2% desde el pico
  // 3. No hay pérdidas extremas
  
  const timeCondition = timeSinceLastTrade > (30 * 60 * 1000); // 30 minutos
  const profitCondition = dailyStats.peakProfit > 0 && 
    (dailyStats.profit < dailyStats.peakProfit * 0.98); // Bajó 2% desde el pico
  const noExtremeLosses = dailyProfitPct > -config.MAX_DRAWDOWN;
  
  if (timeCondition && profitCondition && noExtremeLosses) {
    logFile(`🔄 Condiciones para reanudar trading cumplidas - Reanudando operaciones`);
    dailyStats.lastTradeTime = now; // Reset timer
    return true;
  }
  
  return false;
}

function analyzeMarketConditions(klines, indicators) {
  const volumeProfile = calcVolumeProfile(klines);
  const trendStrength = calcTrendStrength(klines);
  const supportResistance = calcSupportResistance(klines);
  
  // Actualizar condiciones del mercado
  marketConditions.trend = trendStrength.strength;
  marketConditions.volatility = indicators.atr > indicators.lastPrice * 0.02 ? 'HIGH' : 'LOW';
  marketConditions.volume = volumeProfile.isHighVolume ? 'HIGH' : 'NORMAL';
  
  return {
    trend: marketConditions.trend,
    volatility: marketConditions.volatility,
    volume: marketConditions.volume,
    nearSupport: supportResistance.nearSupport,
    nearResistance: supportResistance.nearResistance,
    volumeRatio: volumeProfile.volumeRatio
  };
}

// ---------- Advanced Strategy Evaluator ----------
async function evaluateAndAct() {
  if (!AUTO_TRADE) return;
  if (isEvaluating) return;
  isEvaluating = true;
  
  const t0 = Date.now();
  const pstat = platformStatus();
  if (String(pstat.platform || '').startsWith('binance') && !pstat.binanceConfigured) {
    logFile('⚠️ Binance sin credenciales: solo monitoreo. Configure API keys en /api/binance o desde el panel.');
    isEvaluating = false;
    return;
  }
  try {
    // Actualizar estadísticas diarias
    await updateDailyStats();
    
    // Verificar límites de riesgo
    const riskStatus = checkRiskLimits();
    if (riskStatus === false) {
      logFile('⛔ Trading pausado por límites de riesgo extremos');
      return;
    }
    
    const monitorOnly = riskStatus === 'MONITOR_ONLY';

    const symbol = config.SYMBOL || defaultConfig.SYMBOL;
    const interval = config.INTERVAL || defaultConfig.INTERVAL;
    const limit = 500;

    // Obtener datos de mercado
    const klinesResp = await client.klines(symbol, interval, { limit });
    const raw = klinesResp.data;
    const klines = raw.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
    
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const lastPrice = closes[closes.length - 1];

    // Calcular todos los indicadores
    const ema50arr = emaArray(closes, 50);
    const ema200arr = emaArray(closes, 200);
    const ema50 = ema50arr[ema50arr.length - 1];
    const ema200 = ema200arr[ema200arr.length - 1];
    const ema50_prev = ema50arr[ema50arr.length - 2];
    const ema200_prev = ema200arr[ema200arr.length - 2];

    const rsi = calcRSI(closes, 14);
    const macd = calcMACD(closes, 12, 26, 9);
    const atr = calcATR(klines, 14);
    const boll = calcBollinger(closes, config.BOLLINGER_PERIOD, config.BOLLINGER_STD);
    const stochastic = calcStochastic(klines);
    const williamsR = calcWilliamsR(klines);
    const volumeProfile = calcVolumeProfile(klines);
    const supportResistance = calcSupportResistance(klines);
    const trendStrength = calcTrendStrength(klines);

    const indicators = {
      ema50, ema200, ema50_prev, ema200_prev,
      rsi, macd, atr, boll, stochastic, williamsR,
      volumeProfile, supportResistance, trendStrength,
      lastPrice
    };

    // Analizar condiciones del mercado
    const marketState = analyzeMarketConditions(klines, indicators);

    logFile(`📊 ${symbol}: Price=${lastPrice.toFixed(2)} | RSI=${(rsi || 0).toFixed(1)} | MACD=${macd ? macd.hist.toFixed(6) : 'N/A'} | Trend=${marketState.trend} | Vol=${marketState.volume}`);

    // Actualizar posiciones abiertas desde DB
    const dbOpen = await db.all(`SELECT * FROM positions WHERE closedAt IS NULL`);
    openPositions = dbOpen.map(r => ({
      id: r.id, symbol: r.symbol, qty: r.qty, 
      entryPrice: r.entryPrice, stopLoss: r.stopLoss, 
      takeProfit: r.takeProfit, openedAt: r.openedAt, side: r.side 
    }));

    // Gestionar posiciones existentes (siempre activo)
    await manageExistingPositions(lastPrice, indicators);

    // En modo monitoreo, solo gestionar posiciones existentes
    if (monitorOnly) {
      logFile(`👁️ Modo monitoreo activo - Solo gestionando posiciones existentes (${openPositions.length} abiertas)`);
      return;
    }

    // Verificar límite de posiciones
    if (openPositions.length >= config.MAX_OPEN_POSITIONS) {
      logFile(`📈 Máximo de posiciones alcanzado: ${openPositions.length}/${config.MAX_OPEN_POSITIONS}`);
      return;
    }

    // Evaluar múltiples estrategias
    const strategies = await evaluateStrategies(klines, indicators, marketState);
    
    if (strategies.length > 0) {
      // Ejecutar la estrategia con mayor confianza
      const bestStrategy = strategies.reduce((best, current) => 
        current.confidence > best.confidence ? current : best
      );
      
      await executeStrategy(bestStrategy, symbol, lastPrice, indicators);
    } else {
      logFile('🔍 No hay señales de trading válidas en este ciclo');
    }

  } catch (err) {
    schedulerMetrics.evalErrors++;
    logFile('❌ Error en evaluateAndAct: ' + (err?.response?.data || err.message || err));
  } finally {
    schedulerMetrics.lastEvalAt = Date.now();
    schedulerMetrics.lastEvalDurationMs = Date.now() - t0;
    isEvaluating = false;
  }
}

// Función para gestionar posiciones existentes
async function manageExistingPositions(currentPrice, indicators) {
  for (let i = openPositions.length - 1; i >= 0; i--) {
    const pos = openPositions[i];
    const holdMs = Date.now() - pos.openedAt;

    // Trailing stop (solo LONG)
    if (config.TRAILING_STOP_ENABLE && indicators.atr && currentPrice > pos.entryPrice + indicators.atr) {
      const candidateSL = currentPrice - (indicators.atr * (config.TRAILING_STOP_ATR_MULT || 0.5));
      if (candidateSL > pos.stopLoss) {
        pos.stopLoss = candidateSL;
        try {
          await updatePositionSLTPInDB(pos.id, pos.stopLoss, pos.takeProfit);
          logFile(`🔧 Trailing SL ajustado para pos ${pos.id}: nuevo SL=${pos.stopLoss.toFixed(2)}`);
        } catch (e) { /* ignore */ }
      }
    }
    
    // Verificar SL/TP/Max Hold Time
    const hitSL = currentPrice <= pos.stopLoss;
    const hitTP = currentPrice >= pos.takeProfit;
    const hitMaxHold = holdMs >= (config.MAX_HOLD_TIME_MS || Infinity);

    if (hitSL || hitTP || hitMaxHold) {
      try {
        let reason = hitSL ? 'Stop Loss' : (hitTP ? 'Take Profit' : 'Max Hold Time');
        logFile(`🎯 ${reason} activado para posición ${pos.id}: Precio=${currentPrice.toFixed(2)} | SL=${pos.stopLoss.toFixed(2)} | TP=${pos.takeProfit.toFixed(2)} | Hold=${(holdMs/1000).toFixed(0)}s`);
        await marketSellByQty(pos.symbol, pos.qty);
        await logTradeToDB({
          symbol: pos.symbol, side: 'SELL', qty: pos.qty,
          price: currentPrice, type: 'AUTO', info: `${reason} exit`
        });
        await closePositionInDB(pos.id, Date.now(), currentPrice);
        dailyStats.trades++;
      } catch (err) {
        logFile('❌ Error cerrando posición: ' + (err?.response?.data || err.message || err));
      }
      openPositions.splice(i, 1);
      continue;
    }

    // Gating para salidas tempranas (actualmente deshabilitado por defecto)
    const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
    const canEarlyExit = Boolean(config.EARLY_EXIT_ENABLE) && holdMs >= (config.MIN_HOLD_TIME_MS || 0);

    if (canEarlyExit) {
      const shouldExitEarly = checkEarlyExitSignals(pos, indicators, pnlPct);
      if (shouldExitEarly) {
        try {
          logFile(`⚡ Salida temprana para posición ${pos.id}: ${shouldExitEarly.reason} | PnL=${(pnlPct*100).toFixed(2)}%`);
          await marketSellByQty(pos.symbol, pos.qty);
          await logTradeToDB({
            symbol: pos.symbol, side: 'SELL', qty: pos.qty,
            price: currentPrice, type: 'AUTO', info: `Early exit: ${shouldExitEarly.reason}`
          });
          await closePositionInDB(pos.id, Date.now(), currentPrice);
          dailyStats.trades++;
        } catch (err) {
          logFile('❌ Error en salida temprana: ' + (err?.response?.data || err.message || err));
        }
        openPositions.splice(i, 1);
      }
    }
  }
}

// Función para verificar señales de salida temprana
function checkEarlyExitSignals(position, indicators, pnlPct) {
  const { rsi, macd, trendStrength } = indicators;

  // Condición 1: Salir si la ganancia es pequeña y hay una fuerte señal de reversión.
  // Esto previene que una pequeña ganancia se convierta en pérdida.
  if (pnlPct > 0 && pnlPct < (config.EARLY_EXIT_MIN_PROFIT || 0.005)) {
    // Señal de reversión: RSI cruzando hacia abajo desde sobrecompra y MACD volviéndose negativo.
    if (rsi !== null && rsi < 55 && macd && macd.hist < 0 && trendStrength.strength === 'BEARISH') {
      return { reason: 'Reversión bajista inminente con ganancia mínima' };
    }
  }

  // Condición 2: Salir si se alcanza un umbral de pérdida y el mercado muestra debilidad.
  // Esto es para cortar pérdidas antes de que lleguen al Stop Loss si el mercado se ve mal.
  if (pnlPct <= (config.EARLY_EXIT_MAX_LOSS || -0.01)) {
    if (macd && macd.hist < 0 && trendStrength.strength === 'BEARISH' && trendStrength.confidence > 0.6) {
      return { reason: 'Pérdida superando umbral con fuerte confirmación bajista' };
    }
  }

  // Si no hay señales claras de salida, no hacer nada.
  return null;
}

// Función para evaluar múltiples estrategias
async function evaluateStrategies(klines, indicators, marketConditions) {
  const strategies = [];
  
  // Estrategia 1: EMA Crossover (original mejorada)
  if (config.ENABLE_SWING_TRADING) {
    const emaStrategy = evaluateEMAStrategy(klines, indicators, marketConditions);
    if (emaStrategy) strategies.push(emaStrategy);
  }
  
  // Estrategia 2: Scalping con RSI (más agresiva)
  if (config.ENABLE_SCALPING) {
    const scalpingStrategy = evaluateScalpingStrategy(klines, indicators, marketConditions);
    if (scalpingStrategy) strategies.push(scalpingStrategy);
  }
  
  // Estrategia 3: Breakout Trading
  if (config.ENABLE_BREAKOUT_TRADING) {
    const breakoutStrategy = evaluateBreakoutStrategy(klines, indicators, marketConditions);
    if (breakoutStrategy) strategies.push(breakoutStrategy);
  }
  
  // Estrategia 4: Momentum Trading (NUEVA)
  if (config.ENABLE_MOMENTUM_TRADING) {
    const momentumStrategy = evaluateMomentumStrategy(klines, indicators, marketConditions);
    if (momentumStrategy) strategies.push(momentumStrategy);
  }
  
  // Estrategia 5: Mean Reversion (NUEVA)
  if (config.ENABLE_MEAN_REVERSION) {
    const meanReversionStrategy = evaluateMeanReversionStrategy(klines, indicators, marketConditions);
    if (meanReversionStrategy) strategies.push(meanReversionStrategy);
  }
  
  // Estrategia 6: Trend Following (NUEVA)
  if (config.ENABLE_TREND_FOLLOWING) {
    const trendFollowingStrategy = evaluateTrendFollowingStrategy(klines, indicators, marketConditions);
    if (trendFollowingStrategy) strategies.push(trendFollowingStrategy);
  }
  
  return strategies;
}

// Estrategia EMA Crossover mejorada
function evaluateEMAStrategy(klines, indicators, marketConditions) {
  const { ema50, ema200, ema50_prev, ema200_prev, rsi, macd, boll, volumeProfile } = indicators;
  
  const bullishCross = (ema50_prev !== null && ema200_prev !== null) && 
                      (ema50_prev <= ema200_prev && ema50 > ema200);
  
  const macdOk = macd && macd.hist > config.MACD_SIGNAL_THRESHOLD;
  const rsiOk = rsi !== null && rsi > config.RSI_OVERSOLD && rsi < config.RSI_OVERBOUGHT;
  const volumeOk = volumeProfile.volumeRatio > config.VOLUME_THRESHOLD;
  const bollOk = boll ? (indicators.lastPrice > boll.lower && indicators.lastPrice < boll.upper) : true;
  
  if (bullishCross && macdOk && rsiOk && volumeOk && bollOk) {
    return {
      name: 'EMA Crossover',
      confidence: 0.8,
      entryPrice: indicators.lastPrice,
      stopLoss: indicators.lastPrice - (indicators.atr * config.ATR_MULTIPLIER),
      takeProfit: indicators.lastPrice + (indicators.atr * config.TAKE_PROFIT_MULTIPLIER),
      reason: 'EMA50 cruza EMA200 con confirmación de volumen y RSI'
    };
  }
  
  return null;
}

// Estrategia de Scalping (MÁS AGRESIVA)
function evaluateScalpingStrategy(klines, indicators, marketConditions) {
  const { rsi, stochastic, williamsR, volumeProfile, trendStrength, macd } = indicators;
  
  // Condiciones más permisivas para scalping
  const rsiOversold = rsi !== null && rsi < config.RSI_OVERSOLD;
  const rsiNeutralLow = rsi !== null && rsi < config.RSI_NEUTRAL_LOW && rsi > 30;
  const stochasticOversold = stochastic && stochastic.k < 30; // Más permisivo
  const williamsOversold = williamsR !== null && williamsR < -70; // Más permisivo
  const volumeOk = volumeProfile.volumeRatio > config.VOLUME_THRESHOLD;
  const macdPositive = macd && macd.hist > 0;
  
  // Condición más simple: RSI bajo + volumen + MACD positivo
  if ((rsiOversold || rsiNeutralLow) && volumeOk && macdPositive) {
    return {
      name: 'Scalping RSI Agresivo',
      confidence: 0.6,
      entryPrice: indicators.lastPrice,
      stopLoss: indicators.lastPrice * 0.997, // Stop loss muy ajustado
      takeProfit: indicators.lastPrice * 1.003, // Take profit pequeño
      reason: 'RSI bajo con volumen y MACD positivo'
    };
  }
  
  return null;
}

// Estrategia de Breakout (MÁS PERMISIVA)
function evaluateBreakoutStrategy(klines, indicators, marketConditions) {
  const { boll, volumeProfile, supportResistance, trendStrength } = indicators;
  
  if (!boll) return null;
  
  // Breakout más permisivo
  const nearUpperBand = indicators.lastPrice > boll.ma + (boll.std * 1.5); // Cerca de banda superior
  const volumeBreakout = volumeProfile.volumeRatio > config.VOLUME_THRESHOLD;
  const trendConfirmation = trendStrength.strength !== 'BEARISH'; // No bajista
  
  if (nearUpperBand && volumeBreakout && trendConfirmation) {
    return {
      name: 'Breakout Bollinger',
      confidence: 0.65,
      entryPrice: indicators.lastPrice,
      stopLoss: boll.ma, // Stop loss en la media móvil
      takeProfit: indicators.lastPrice + (boll.std * 2), // Take profit moderado
      reason: 'Cerca de banda superior con volumen confirmado'
    };
  }
  
  return null;
}

// NUEVA Estrategia de Momentum
function evaluateMomentumStrategy(klines, indicators, marketConditions) {
  const { rsi, macd, volumeProfile, trendStrength } = indicators;
  
  // Calcular momentum de precio
  const recentPrices = klines.slice(-config.MOMENTUM_PERIOD).map(k => k.close);
  const priceChange = (recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0];
  
  // Condiciones para momentum
  const positiveMomentum = priceChange > config.PRICE_CHANGE_THRESHOLD;
  const rsiMomentum = rsi !== null && rsi > 50 && rsi < config.RSI_OVERBOUGHT;
  const macdMomentum = macd && macd.hist > config.MACD_SIGNAL_THRESHOLD;
  const volumeMomentum = volumeProfile.volumeRatio > config.VOLUME_THRESHOLD;
  
  if (positiveMomentum && rsiMomentum && macdMomentum && volumeMomentum) {
    return {
      name: 'Momentum Trading',
      confidence: 0.7,
      entryPrice: indicators.lastPrice,
      stopLoss: indicators.lastPrice * 0.995, // Stop loss ajustado
      takeProfit: indicators.lastPrice * 1.008, // Take profit moderado
      reason: `Momentum positivo ${(priceChange * 100).toFixed(2)}% con confirmación`
    };
  }
  
  return null;
}

// NUEVA Estrategia de Mean Reversion
function evaluateMeanReversionStrategy(klines, indicators, marketConditions) {
  const { rsi, boll, volumeProfile, supportResistance } = indicators;
  
  if (!boll) return null;
  
  // Condiciones para reversión a la media
  const priceBelowLower = indicators.lastPrice < boll.lower;
  const priceNearSupport = supportResistance.nearSupport;
  const rsiOversold = rsi !== null && rsi < config.RSI_OVERSOLD;
  const volumeOk = volumeProfile.volumeRatio > config.VOLUME_THRESHOLD;
  
  if ((priceBelowLower || priceNearSupport) && rsiOversold && volumeOk) {
    return {
      name: 'Mean Reversion',
      confidence: 0.65,
      entryPrice: indicators.lastPrice,
      stopLoss: indicators.lastPrice * 0.992, // Stop loss ajustado
      takeProfit: boll.ma, // Take profit en la media móvil
      reason: 'Precio en zona de reversión con RSI sobreventa'
    };
  }
  
  return null;
}

// NUEVA Estrategia de Trend Following
function evaluateTrendFollowingStrategy(klines, indicators, marketConditions) {
  const { ema50, ema200, rsi, macd, volumeProfile, trendStrength } = indicators;
  
  // Condiciones para seguimiento de tendencia
  const uptrend = ema50 > ema200; // EMA50 > EMA200
  const rsiTrend = rsi !== null && rsi > 45 && rsi < config.RSI_OVERBOUGHT;
  const macdTrend = macd && macd.hist > config.MACD_SIGNAL_THRESHOLD;
  const volumeTrend = volumeProfile.volumeRatio > config.VOLUME_THRESHOLD;
  const trendConfirmation = trendStrength.strength === 'BULLISH' || trendStrength.strength === 'NEUTRAL';
  
  if (uptrend && rsiTrend && macdTrend && volumeTrend && trendConfirmation) {
    return {
      name: 'Trend Following',
      confidence: 0.6,
      entryPrice: indicators.lastPrice,
      stopLoss: ema50, // Stop loss en EMA50
      takeProfit: indicators.lastPrice * 1.01, // Take profit conservador
      reason: 'Seguimiento de tendencia alcista confirmada'
    };
  }
  
  return null;
}

// Función para ejecutar una estrategia
async function executeStrategy(strategy, symbol, currentPrice, indicators) {
  try {
    const usdtBal = await getFreeBalance('USDT');
    const quoteToSpend = Math.floor((usdtBal * config.RISK_PERCENT) * 100) / 100;
    
    if (quoteToSpend < config.MIN_USDT_TO_TRADE) {
      logFile(`💰 Balance insuficiente para trading: ${usdtBal} USDT`);
      return;
    }
    
    logFile(`🚀 Ejecutando estrategia: ${strategy.name} | Confianza: ${(strategy.confidence * 100).toFixed(1)}% | Monto: ${quoteToSpend} USDT`);
    
    // Ejecutar orden de compra
    const buyResp = await marketBuyByQuote(symbol, quoteToSpend);
    
    // Determinar ejecución real
    let executedQty = 0;
    let totalQuote = 0;

    // 1) Intentar con executedQty directo
    if (buyResp && typeof buyResp.executedQty !== 'undefined') {
      executedQty = parseFloat(buyResp.executedQty || 0);
      totalQuote = parseFloat(buyResp.cummulativeQuoteQty || 0);
    }

    // 2) Intentar con fills
    if (executedQty === 0 && buyResp && buyResp.fills) {
      for (const f of buyResp.fills) {
        executedQty += parseFloat(f.qty);
        totalQuote += parseFloat(f.qty) * parseFloat(f.price);
      }
    }

    // 3) Consultar el estado de la orden al exchange
    if (executedQty === 0 && buyResp && buyResp.orderId) {
      try {
        const ord = await client.getOrder(symbol, { orderId: buyResp.orderId });
        executedQty = parseFloat(ord.data.executedQty || 0);
        totalQuote = parseFloat(ord.data.cummulativeQuoteQty || 0);
      } catch (e) {
        // ignore
      }
    }

    // 4) Fallback estimado
    if (executedQty === 0) {
      executedQty = quoteToSpend / currentPrice;
      totalQuote = quoteToSpend;
    }

    const entryPrice = executedQty ? (totalQuote / executedQty) : currentPrice;
    
    // Crear posición
    const pos = {
      symbol,
      qty: executedQty,
      entryPrice,
      stopLoss: strategy.stopLoss,
      takeProfit: strategy.takeProfit,
      openedAt: Date.now(),
      side: 'LONG',
      note: `${strategy.name}: ${strategy.reason}`
    };
    
    const id = await savePositionToDB(pos);
    pos.id = id;
    openPositions.push(pos);
    await logTradeToDB({
      symbol, side: 'BUY', qty: pos.qty, 
      price: entryPrice, type: 'AUTO', info: strategy.name 
    });
    
    dailyStats.trades++;
    dailyStats.lastTradeTime = Date.now(); // Registrar timestamp del trade
    
    logFile(`✅ Nueva posición abierta: ID=${id} | Cantidad=${executedQty.toFixed(6)} | Entrada=${entryPrice.toFixed(2)} | SL=${strategy.stopLoss.toFixed(2)} | TP=${strategy.takeProfit.toFixed(2)}`);
    
  } catch (err) {
    logFile('❌ Error ejecutando estrategia: ' + (err?.response?.data || err.message || err));
  }
}

// Scheduler
let schedulerHandle = null;
let schedulerMetrics = { lastEvalAt: 0, lastEvalDurationMs: 0, evalErrors: 0 };
function startAutoScheduler() {
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(() => {
    if (AUTO_TRADE) evaluateAndAct().catch(e => logFile('evaluateAndAct crash: ' + e));
  }, (config.AUTO_INTERVAL_SEC || defaultConfig.AUTO_INTERVAL_SEC) * 1000);
  logFile(`Auto scheduler started with interval ${config.AUTO_INTERVAL_SEC || defaultConfig.AUTO_INTERVAL_SEC}s`);
}
function stopAutoScheduler() {
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = null;
  logFile('Auto scheduler stopped');
}

// ---------- Backtest (improved with commission & slippage) ----------
function runBacktest(klines, params = {}) {
  // Simple backtester for the EMA50/200 + MACD + RSI strategy
  // klines: [{openTime, open, high, low, close}]
  const conf = { ...defaultConfig, ...params };
  const closes = klines.map(k => k.close);
  const ema50arr = emaArray(closes, 50);
  const ema200arr = emaArray(closes, 200);
  let capital = params.initialCapital || 10000;
  const trades = [];
  let position = null;
  const commissionFactor = 1 - (conf.COMMISSION_PCT || defaultConfig.COMMISSION_PCT);
  const slippagePct = conf.SLIPPAGE_PCT || defaultConfig.SLIPPAGE_PCT;

  for (let i = 201; i < closes.length; i++) {
    const price = closes[i];
    const ema50 = ema50arr[i];
    const ema200 = ema200arr[i];
    const ema50_prev = ema50arr[i - 1];
    const ema200_prev = ema200arr[i - 1];
    const macd = calcMACD(closes.slice(0, i + 1), 12, 26, 9);
    const rsi = calcRSI(closes.slice(0, i + 1), 14);
    const atr = calcATR(klines.slice(0, i + 1), 14);

    const bullishCross = (ema50_prev !== null && ema200_prev !== null) && (ema50_prev <= ema200_prev && ema50 > ema200);
    const macdOk = macd && macd.hist > 0;
    const rsiOk = rsi !== null && rsi > 25 && rsi < 85;

    if (!position) {
      if (bullishCross && macdOk && rsiOk && atr) {
        // enter market at price*(1+slippage)
        const entryPrice = price * (1 + slippagePct);
        const riskUsd = capital * (conf.RISK_PERCENT || defaultConfig.RISK_PERCENT);
        const qty = riskUsd / entryPrice;
        const stop = entryPrice - (atr * (conf.ATR_MULTIPLIER || defaultConfig.ATR_MULTIPLIER));
        const tp = entryPrice + (atr * (conf.TAKE_PROFIT_MULTIPLIER || defaultConfig.TAKE_PROFIT_MULTIPLIER));
        position = { entryIndex: i, entryPrice, qty, stop, tp };
      }
    } else {
      // check stop/tp triggered at price (we simulate market execution on close)
      if (price <= position.stop || price >= position.tp) {
        const exitPrice = price * (1 - slippagePct); // worse exit
        const gross = (exitPrice - position.entryPrice) * position.qty;
        const net = gross * commissionFactor;
        capital += net;
        trades.push({ entry: position.entryPrice, exit: exitPrice, pnl: net });
        position = null;
      }
    }
  }
  const result = { finalCapital: capital, trades, totalTrades: trades.length, profit: capital - (params.initialCapital || 10000) };
  return result;
}

// ---------- Express Endpoints ----------

// ============================== 
// 🔄 Basic status + balances + orders + positions
// ============================== 
app.get('/estado', async (req, res) => {
  try {
    let balancesResp = null;
    const pstat = platformStatus();
    if (String(pstat.platform || '').startsWith('binance') && pstat.binanceConfigured) {
      balancesResp = await client.account();
    }

    // balances siempre será un array con estructura consistente
    const balances = ((balancesResp && balancesResp.data?.balances) || []).filter(
      b => parseFloat(b.free || 0) > 0 || parseFloat(b.locked || 0) > 0
    ).map(b => ({
      asset: String(b.asset || ''),
      free: String(parseFloat(b.free || 0).toFixed(8)),
      locked: String(parseFloat(b.locked || 0).toFixed(8))
    }));

    // openOrders siempre será un array con estructura consistente
    let openOrdersResp = { data: [] };
    if (String(pstat.platform || '').startsWith('binance') && pstat.binanceConfigured) {
      openOrdersResp = await client.openOrders();
    }
    const openOrders = (openOrdersResp.data || []).map(o => ({
      symbol: String(o.symbol || ''),
      orderId: Number(o.orderId || 0),
      side: String(o.side || ''),
      type: String(o.type || ''),
      origQty: String(parseFloat(o.origQty || 0).toFixed(8)),
      executedQty: String(parseFloat(o.executedQty || 0).toFixed(8)),
      cummulativeQuoteQty: String(parseFloat(o.cummulativeQuoteQty || 0).toFixed(8)),
      price: String(parseFloat(o.price || 0).toFixed(8)),
      status: String(o.status || ''),
      timeInForce: String(o.timeInForce || ''),
      time: Number(o.time || 0),
      updateTime: Number(o.updateTime || o.time || 0),
      isWorking: Boolean(o.isWorking)
    }));

    // ticker siempre será un número válido
    const ticker = await client.tickerPrice(config.SYMBOL || defaultConfig.SYMBOL);
    const btcPrice = parseFloat(ticker?.data?.price || 0);

    // posiciones abiertas desde la DB con estructura consistente
    const dbOpen = await db.all(`SELECT * FROM positions WHERE closedAt IS NULL`);
    const openPositions = (dbOpen || []).map(r => ({
      id: Number(r.id || 0),
      symbol: String(r.symbol || ''),
      qty: parseFloat(r.qty || 0),
      entryPrice: parseFloat(r.entryPrice || 0),
      stopLoss: parseFloat(r.stopLoss || 0),
      takeProfit: parseFloat(r.takeProfit || 0),
      openedAt: Number(r.openedAt || 0),
      side: String(r.side || '')
    }));

    // config siempre será un objeto con estructura consistente
    const configResponse = {
      SYMBOL: String(config.SYMBOL || defaultConfig.SYMBOL),
      INTERVAL: String(config.INTERVAL || defaultConfig.INTERVAL),
      RISK_PERCENT: parseFloat(config.RISK_PERCENT || defaultConfig.RISK_PERCENT),
      ATR_MULTIPLIER: parseFloat(config.ATR_MULTIPLIER || defaultConfig.ATR_MULTIPLIER),
      TAKE_PROFIT_MULTIPLIER: parseFloat(config.TAKE_PROFIT_MULTIPLIER || defaultConfig.TAKE_PROFIT_MULTIPLIER),
      MIN_USDT_TO_TRADE: parseFloat(config.MIN_USDT_TO_TRADE || defaultConfig.MIN_USDT_TO_TRADE),
      AUTO_INTERVAL_SEC: Number(config.AUTO_INTERVAL_SEC || defaultConfig.AUTO_INTERVAL_SEC),
      MAX_OPEN_POSITIONS: Number(config.MAX_OPEN_POSITIONS || defaultConfig.MAX_OPEN_POSITIONS),
      COMMISSION_PCT: parseFloat(config.COMMISSION_PCT || defaultConfig.COMMISSION_PCT),
      SLIPPAGE_PCT: parseFloat(config.SLIPPAGE_PCT || defaultConfig.SLIPPAGE_PCT)
    };

    // respuesta SIEMPRE con estructura fija y tipos consistentes
    res.json({
      balances: balances,
      openOrders: openOrders,
      btcPrice: btcPrice,
      positions: openPositions,
      config: configResponse,
      auto: Boolean(AUTO_TRADE),
      platform: platformManager ? platformManager.platform : 'unknown'
    });

  } catch (err) {
    console.error("❌ ERROR /estado:", err?.response?.data || err.message || err);
    res.status(500).json({
      error: String(err?.response?.data || err.message || "Unknown error")
    });
  }
});


// get klines (for frontend)
app.get('/klines', async (req, res) => {
  try {
    const interval = req.query.interval || config.INTERVAL || defaultConfig.INTERVAL;
    const limit = parseInt(req.query.limit || '200', 10);
    const resp = await client.klines(config.SYMBOL || defaultConfig.SYMBOL, interval, { limit });
    const out = resp.data.map(k => ({ openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message || err });
  }
});

// manual order
app.post('/orden', async (req, res) => {
  try {
    // Normalizar y validar parámetros
    const rawSymbol = (req.body.symbol || '').toString().trim().toUpperCase();
    const rawSide = (req.body.side || '').toString().trim().toUpperCase();
    const rawType = (req.body.type || 'MARKET').toString().trim().toUpperCase();
    const qtyNum = Number(req.body.quantity);
    const priceNum = req.body.price !== undefined && req.body.price !== null ? Number(req.body.price) : null;

    if (!rawSymbol || !rawSide || !Number.isFinite(qtyNum) || qtyNum <= 0) {
      return res.status(400).json({ error: 'Parámetros inválidos' });
    }
    if (rawType === 'LIMIT' && (!Number.isFinite(priceNum) || priceNum <= 0)) {
      return res.status(400).json({ error: 'Precio inválido para orden LIMIT' });
    }

    // Variables normalizadas para el resto del flujo
    let symbol = rawSymbol;
    let side = rawSide;
    let type = rawType;

    // Obtener precio actual para validación
    const ticker = await client.tickerPrice(symbol);
    const currentPrice = parseFloat(ticker.data.price);
    let usedPrice = currentPrice;
    let formattedPrice = null;
    
    // Usar las nuevas funciones de formateo
    const filters = await getSymbolFilters(symbol);
    const formattedQty = formatQuantity(qtyNum, filters.stepSize);
    
    let order;
    if (type === 'MARKET') {
      // Para órdenes de mercado, usar el precio actual
      if (side === 'BUY') {
        // Para compra, usar quoteOrderQty (cantidad en USDT)
        const quoteAmount = parseFloat(formattedQty) * currentPrice;
        const precision = filters.quotePrecision || 2;
        const formattedQuote = parseFloat(quoteAmount).toFixed(precision);
        order = await marketBuyByQuote(symbol, parseFloat(formattedQuote));
      } else {
        // Para venta, usar quantity (cantidad en crypto)
        order = await marketSellByQty(symbol, parseFloat(formattedQty));
      }
    } else {
      // Para órdenes limit, validar que el precio esté dentro del rango permitido
      formattedPrice = Number.isFinite(priceNum) ? formatPrice(priceNum, filters.tickSize) : currentPrice;
      usedPrice = parseFloat(formattedPrice);
      
      // Validar que el precio no esté muy lejos del precio de mercado (máximo 5%)
      const priceDiff = Math.abs(parseFloat(formattedPrice) - currentPrice) / currentPrice;
      if (priceDiff > 0.05) {
        return res.status(400).json({ 
          error: `Precio ${formattedPrice} muy lejos del precio de mercado ${currentPrice.toFixed(2)} (diferencia: ${(priceDiff * 100).toFixed(1)}%)` 
        });
      }
      
      // Verificar minNotional
      if (filters.minNotional) {
        const notional = parseFloat(formattedQty) * parseFloat(formattedPrice);
        if (notional < filters.minNotional) {
          return res.status(400).json({ 
            error: `Valor de orden ${notional.toFixed(8)} por debajo del mínimo ${filters.minNotional}` 
          });
        }
      }
      
      order = await limitOrder(symbol, side, parseFloat(formattedQty), parseFloat(formattedPrice));
    }
    
    await logTradeToDB({
      symbol, side, qty: parseFloat(formattedQty), 
      price: usedPrice, 
      type: 'MANUAL', info: 'Manual order from UI' 
    });
    
    logFile(`✅ ORDEN MANUAL EJECUTADA: ${side} ${formattedQty} ${symbol} @ ${usedPrice.toFixed(2)} (${type})`);
    
    res.json(order);
  } catch (err) {
    const errorMsg = `❌ ERROR AL CREAR ORDEN: ${err?.response?.data || err.message || err}`;
    logFile(errorMsg);
    res.status(500).json({ error: err?.response?.data || err.message || err });
  }
});

// cancel order (manual)
app.post('/orders/cancel', async (req, res) => {
  try {
    const { symbol, orderId } = req.body;
    if (!symbol || !orderId) return res.status(400).json({ error: 'symbol and orderId required' });
    const resp = await client.cancelOrder(symbol, { orderId });
    res.json(resp.data);
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message || err });
  }
});

// autotrade control
app.post('/autotrade/start', (req, res) => {
  AUTO_TRADE = true;
  startAutoScheduler();
  res.json({ ok: true, auto: true });
});
app.post('/autotrade/stop', (req, res) => {
  AUTO_TRADE = false;
  res.json({ ok: true, auto: false });
});

// status
app.get('/status', async (req, res) => {
  res.json({ AUTO_TRADE, config, openPositions });
});

// Platform status and control
app.get('/platform', async (req, res) => {
  try {
    const status = platformManager ? platformManager.getStatus() : { platform: 'unknown' };
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});
app.post('/platform', async (req, res) => {
  try {
    const { platform } = req.body || {};
    const allowed = ['binance_live', 'binance_testnet', 'mt5'];
    if (!allowed.includes(platform)) return res.status(400).json({ error: 'Invalid platform' });
    if (config.PLATFORM !== platform) {
      config.PLATFORM = platform;
      await db.run(`INSERT INTO config(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?`,
        'PLATFORM', JSON.stringify(platform), JSON.stringify(platform));
      platformManager.setPlatform(platform);
      refreshClientAndCaches();
      startAutoScheduler();
    }
    res.json({ ok: true, status: platformManager.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message || String(err) });
  }
});
app.post('/api/binance', async (req, res) => {
  try {
    const { apiKey, apiSecret, persist } = req.body || {};
    if (!apiKey || !apiSecret) return res.status(400).json({ error: 'apiKey and apiSecret required' });

    platformManager.setBinanceKeys({ apiKey, apiSecret });

    if (persist) {
      config.BINANCE_API_KEY = apiKey;
      config.BINANCE_API_SECRET = apiSecret;
      await db.run(`INSERT INTO config(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?`, 'BINANCE_API_KEY', JSON.stringify(apiKey), JSON.stringify(apiKey));
      await db.run(`INSERT INTO config(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?`, 'BINANCE_API_SECRET', JSON.stringify(apiSecret), JSON.stringify(apiSecret));
    } else {
      delete config.BINANCE_API_KEY;
      delete config.BINANCE_API_SECRET;
      await db.run(`DELETE FROM config WHERE key IN ('BINANCE_API_KEY','BINANCE_API_SECRET')`);
    }

    refreshClientAndCaches();
    res.json({ ok: true, status: platformManager.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message || String(err) });
  }
});

// Obtener claves API desde variables de entorno
app.get('/api/binance/keys', async (req, res) => {
  try {
    const envApiKey = process.env.BINANCE_API_KEY;
    const envApiSecret = process.env.BINANCE_API_SECRET;
    const status = platformManager.getStatus();
    
    // Si hay claves en la base de datos, usar esas
    if (config.BINANCE_API_KEY && config.BINANCE_API_SECRET) {
      return res.json({
        apiKey: config.BINANCE_API_KEY,
        apiSecret: config.BINANCE_API_SECRET,
        source: 'database'
      });
    }
    
    // Si hay claves en entorno, usar esas
    if (envApiKey && envApiSecret) {
      return res.json({
        apiKey: envApiKey,
        apiSecret: envApiSecret,
        source: 'environment'
      });
    }
    
    // No hay claves configuradas
    res.json({ 
      apiKey: null, 
      apiSecret: null, 
      source: 'none' 
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// update config
app.post('/config', async (req, res) => {
  try {
    const payload = req.body || {};
    const allowed = [
      'RISK_PERCENT', 'ATR_MULTIPLIER', 'TAKE_PROFIT_MULTIPLIER', 'MIN_USDT_TO_TRADE', 
      'AUTO_INTERVAL_SEC', 'INTERVAL', 'SYMBOL', 'MAX_OPEN_POSITIONS', 'COMMISSION_PCT', 
      'SLIPPAGE_PCT', 'ENABLE_SCALPING', 'ENABLE_SWING_TRADING', 'ENABLE_BREAKOUT_TRADING',
      'ENABLE_MOMENTUM_TRADING', 'ENABLE_MEAN_REVERSION', 'ENABLE_TREND_FOLLOWING',
      'VOLUME_THRESHOLD', 'RSI_OVERSOLD', 'RSI_OVERBOUGHT', 'RSI_NEUTRAL_LOW', 'RSI_NEUTRAL_HIGH',
      'MACD_SIGNAL_THRESHOLD', 'BOLLINGER_PERIOD', 'BOLLINGER_STD', 'TREND_CONFIRMATION_CANDLES', 
      'MAX_DAILY_TRADES', 'PROFIT_TARGET_DAILY', 'MAX_DRAWDOWN', 'MOMENTUM_PERIOD', 
      'MEAN_REVERSION_PERIOD', 'TREND_PERIOD', 'VOLATILITY_THRESHOLD', 'PRICE_CHANGE_THRESHOLD'
    ];
    
    for (const k of allowed) {
      if (payload[k] !== undefined) {
        config[k] = payload[k];
        await db.run(`INSERT INTO config(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?`, 
          k, JSON.stringify(payload[k]), JSON.stringify(payload[k]));
      }
    }
    
    // If interval changed, restart scheduler
    startAutoScheduler();
    logFile(`⚙️ Configuración actualizada: ${Object.keys(payload).join(', ')}`);
    res.json({ ok: true, config });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message || err });
  }
});

// estadísticas del bot
app.get('/stats', async (req, res) => {
  try {
    const pstat = platformStatus();
    if (String(pstat.platform || '').startsWith('binance') && !pstat.binanceConfigured) {
      const stats = {
        daily: {
          trades: dailyStats.trades,
          profit: 0,
          profitPercent: 0,
          peakProfit: dailyStats.peakProfit,
          peakProfitPercent: 0,
          startBalance: 0,
          currentBalance: 0,
          lastReset: dailyStats.lastReset,
          lastTradeTime: dailyStats.lastTradeTime
        },
        market: marketConditions,
        tradingMode: 'PAUSED',
        positions: { open: openPositions.length, max: config.MAX_OPEN_POSITIONS },
        limits: { maxDailyTrades: config.MAX_DAILY_TRADES, profitTarget: config.PROFIT_TARGET_DAILY * 100, maxDrawdown: config.MAX_DRAWDOWN * 100 },
        auto: AUTO_TRADE
      };
      stats.platform = pstat;
      stats.scheduler = schedulerMetrics;
      return res.json(stats);
    }
    await updateDailyStats();
    
    const usdtBalance = await getFreeBalance('USDT');
    const dailyProfitPct = dailyStats.startBalance > 0 ? 
      ((dailyStats.profit / dailyStats.startBalance) * 100) : 0;
    
    const riskStatus = checkRiskLimits();
    const peakProfitPct = dailyStats.startBalance > 0 ? 
      ((dailyStats.peakProfit / dailyStats.startBalance) * 100) : 0;
    
    const stats = {
      daily: {
        trades: dailyStats.trades,
        profit: dailyStats.profit,
        profitPercent: dailyProfitPct,
        peakProfit: dailyStats.peakProfit,
        peakProfitPercent: peakProfitPct,
        startBalance: dailyStats.startBalance,
        currentBalance: usdtBalance,
        lastReset: dailyStats.lastReset,
        lastTradeTime: dailyStats.lastTradeTime
      },
      market: marketConditions,
      tradingMode: riskStatus === 'MONITOR_ONLY' ? 'MONITOR_ONLY' : riskStatus === false ? 'PAUSED' : 'ACTIVE',
      positions: {
        open: openPositions.length,
        max: config.MAX_OPEN_POSITIONS
      },
      limits: {
        maxDailyTrades: config.MAX_DAILY_TRADES,
        profitTarget: config.PROFIT_TARGET_DAILY * 100,
        maxDrawdown: config.MAX_DRAWDOWN * 100
      },
      auto: AUTO_TRADE
    };
    stats.platform = platformManager ? platformManager.getStatus() : null;
    stats.scheduler = schedulerMetrics;
    
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message || err });
  }
});

// backtest
app.post('/backtest', async (req, res) => {
  try {
    const { limit = 1000, interval = config.INTERVAL } = req.body || {};
    const resp = await client.klines(config.SYMBOL || defaultConfig.SYMBOL, interval, { limit });
    const ks = resp.data.map(k => ({ openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }));
    const out = runBacktest(ks, { RISK_PERCENT: config.RISK_PERCENT, ATR_MULTIPLIER: config.ATR_MULTIPLIER, TAKE_PROFIT_MULTIPLIER: config.TAKE_PROFIT_MULTIPLIER, COMMISSION_PCT: config.COMMISSION_PCT, SLIPPAGE_PCT: config.SLIPPAGE_PCT });
    res.json({ ok: true, summary: out });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message || err });
  }
});

// health
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));


// ============================== 
// 📡 Server-Sent Events para logs en tiempo real
// ============================== 
// clients array declared earlier

// Función para enviar logs al frontend via SSE
function pushLog(message) {
  const log = {
    ts: new Date().toISOString(),
    message
  };
  clients.forEach(c => {
    try {
      c.write(`data: ${JSON.stringify(log)}\n\n`);
    } catch (err) {
      // Remove dead connections
      const idx = clients.indexOf(c);
      if (idx !== -1) clients.splice(idx, 1);
    }
  });
  console.log(`[LOG]`, message);
}

// SSE endpoint para logs en tiempo real
app.get('/logs', (req, res) => {
  // Encabezados SSE correctos
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
  res.flushHeaders();

  // Mantener conexión viva
  res.write('retry: 10000\n\n');
  
  // Enviar mensaje inicial de conexión
  const initialMessage = {
    ts: new Date().toISOString(),
    message: '🔗 Conexión SSE establecida correctamente'
  };
  res.write(`data: ${JSON.stringify(initialMessage)}\n\n`);

  // Guardamos cliente en la lista
  clients.push(res);
  
  // Enviar heartbeat cada 30 segundos
  const heartbeat = setInterval(() => {
    try {
      const heartbeatMsg = {
        ts: new Date().toISOString(),
        message: '💓 Heartbeat - Conexión activa'
      };
      res.write(`data: ${JSON.stringify(heartbeatMsg)}\n\n`);
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Limpiar al desconectar
  req.on('close', () => {
    clearInterval(heartbeat);
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
  });
  
  req.on('error', () => {
    clearInterval(heartbeat);
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
  });
});



// ---------- Startup ----------
async function startup() {
  try {
    await initDB();
    try {
      if (config.PLATFORM) platformManager.setPlatform(config.PLATFORM);
      if (config.BINANCE_API_KEY || config.BINANCE_API_SECRET) {
        platformManager.setBinanceKeys({
          apiKey: config.BINANCE_API_KEY || API_KEY,
          apiSecret: config.BINANCE_API_SECRET || API_SECRET
        });
      }
      refreshClientAndCaches();
    } catch (e) {
      logFile('Startup platform init error: ' + (e?.message || e));
    }
    // load open positions from DB into memory
    const dbOpen = await db.all(`SELECT * FROM positions WHERE closedAt IS NULL`);
    openPositions = dbOpen.map(r => ({ id: r.id, symbol: r.symbol, qty: r.qty, entryPrice: r.entryPrice, stopLoss: r.stopLoss, takeProfit: r.takeProfit, openedAt: r.openedAt, side: r.side }));
    // start scheduler if AUTO_TRADE true (but default off)
    startAutoScheduler();
    // start express server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      logFile(`✅ Dashboard & AutoTrader running on http://localhost:${PORT}`);
      logFile(`⚙️ Configuración: ${JSON.stringify(config, null, 2)}`);
      
      // Inicializar estadísticas diarias
      updateDailyStats();
      
      // Enviar algunos logs de prueba para verificar SSE
      setTimeout(() => {
        logFile('🧪 Log de prueba - Sistema SSE funcionando correctamente');
      }, 2000);
      
      setTimeout(() => {
        logFile('📊 Bot iniciado y listo para operar automáticamente');
        logFile(`🎯 Objetivo diario: ${(config.PROFIT_TARGET_DAILY * 100).toFixed(1)}% | Máximo trades: ${config.MAX_DAILY_TRADES}`);
        logFile(`📈 Estrategias activas: ${config.ENABLE_SCALPING ? 'Scalping ' : ''}${config.ENABLE_SWING_TRADING ? 'Swing ' : ''}${config.ENABLE_BREAKOUT_TRADING ? 'Breakout ' : ''}${config.ENABLE_MOMENTUM_TRADING ? 'Momentum ' : ''}${config.ENABLE_MEAN_REVERSION ? 'MeanReversion ' : ''}${config.ENABLE_TREND_FOLLOWING ? 'TrendFollowing' : ''}`);
        logFile(`⚙️ Umbrales: RSI ${config.RSI_OVERSOLD}-${config.RSI_OVERBOUGHT} | Volumen ${config.VOLUME_THRESHOLD}x | MACD ${config.MACD_SIGNAL_THRESHOLD}`);
      }, 4000);
    });

    // graceful shutdown
    process.on('SIGINT', () => {
      logFile('SIGINT received - shutting down');
      process.exit(0);
    });
  } catch (err) {
    logFile('Startup error: ' + (err?.response?.data || err.message || err));
    process.exit(1);
  }
}
startup();
