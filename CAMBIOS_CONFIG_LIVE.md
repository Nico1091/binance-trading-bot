# Cambios de Configuración: Binance Testnet → Live

## 🚨 IMPORTANTE - LEE ANTES DE USAR

Este bot ahora está configurado para **BINANCE LIVE** (dinero real). Ten mucho cuidado al usarlo.

## Cambios Realizados

### 1. platforms.js
- **Línea 49**: Cambiado `binance_testnet` → `binance_live` (plataforma por defecto)
- **Línea 53**: Mantenido condicional para testnet (solo si se selecciona explícitamente)

### 2. bot.js  
- **Línea 59**: Cambiado `binance_testnet` → `binance_live` en inicialización
- **Línea 32**: Mantenido `TESTNET_BASEURL` como referencia (no se usa en live)

### 3. carpeta/index.html
- **Línea 169**: Añadido `selected` a `binance_live`
- **Línea 245**: Actualizado texto de "API de Binance Testnet" → "API de Binance Live"

## ⚠️ PRECAUCIONES DE SEGURIDAD

1. **API Keys**: Usa claves con permisos restringidos:
   - ✅ Spot & Margin Trading
   - ✅ Read/Write (necesario para operar)
   - ❌ NO activar Withdrawals
   - ❌ NO activar Futures (si no usas)

2. **Primera Prueba**: 
   - Empieza con cantidad pequeña (ej: 10-20 USDT)
   - Activa modo MONITOR_ONLY primero para observar señales
   - Verifica que las órdenes se ejecutan correctamente

3. **Riesgos**:
   - El bot opera automáticamente con dinero real
   - Las estrategias pueden generar pérdidas
   - No hay garantía de ganancias

## 📋 Verificación de Conexión

Para confirmar que estás en Live:
1. Inicia el bot: `node bot.js`
2. Revisa el log inicial: debe mostrar "Platform client ready: binance_live"
3. En el dashboard, verifica que "Binance (Live)" esté seleccionado

## 🔧 Configuración de API Keys

Crea un archivo `.env` en la carpeta CARPETA:
```
BINANCE_API_KEY=tu_api_key_live
BINANCE_API_SECRET=tu_api_secret_live
```

O configúralas desde el dashboard web.

## 🚀 Estrategia Excelente - Cuidado

Como mencionaste, la estrategia es excelente. Por eso:
- Mantén las configuraciones de riesgo (RISK_PERCENT: 5%)
- No aumentes MAX_OPEN_POSITIONS drásticamente  
- Monitoriza los logs al principio
- Usa STOP LOSS y TAKE PROFIT configurados

## 🆘 Soporte

Si algo no funciona:
1. Revisa que las API keys sean correctas
2. Verifica permisos en Binance
3. Revisa los logs en trader.log
4. El modo testnet sigue disponible si lo necesitas

---
**Creado**: 24/03/2026  
**Propósito**: Migración segura de Testnet a Live  
**Estado**: Listo para uso con precaución
