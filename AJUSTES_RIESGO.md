# 📈 Ajustes de Riesgo - Configuración Más Agresiva

## 🎯 Objetivo
Aumentar el potencial de ganancias tomando más riesgos, pero solo cuando las señales tienen mayor confianza.

## 📊 Cambios Realizados

### 💰 Gestión de Capital
- **RISK_PERCENT**: 5% → **8%** por operación
- **MAX_OPEN_POSITIONS**: 3 → **5** posiciones simultáneas
- **MAX_DAILY_TRADES**: 100 → **150** operaciones diarias

### 🎯 Objetivos de Ganancia
- **TAKE_PROFIT_MULTIPLIER**: 2.5 → **3.0** (más ambicioso)
- **PROFIT_TARGET_DAILY**: 15% → **25%** diario

### 📈 Filtros de Calidad (más estrictos para mayor confianza)
- **RSI_OVERSOLD**: 30 → **25** (solo compra en sobreventa extrema)
- **RSI_OVERBOUGHT**: 70 → **75** (solo vende en sobrecompra extrema)
- **VOLUME_THRESHOLD**: 1.2 → **1.1** (requiere volumen ligeramente mayor)

## ⚖️ Balance Riesgo/Beneficio

### ✅ Más Oportunidades
- Mayor capital por operación (8% vs 5%)
- Más posiciones simultáneas (5 vs 3)
- Más operaciones diarias (150 vs 100)

### 🛡️ Mayor Confianza
- Señales RSI más estrictas
- Requiere volumen más alto
- Take profit más ambicioso

### 🎯 Resultado Esperado
- **Menos operaciones pero más calidad**
- **Mayor potencial por operación**
- **Protección contra señales débiles**

## ⚠️ Precauciones

1. **Monitorea los primeros días** - Ajusta si es necesario
2. **El stop loss se mantiene igual** - Protección contra pérdidas
3. **El trailing stop sigue activo** - Protege ganancias
4. **Límite diario de pérdidas intacto** - 20% máximo

## 🚀 Para Activar

Reinicia el bot:
```bash
node bot.js
```

Los cambios se aplican automáticamente en la próxima operación.

---
**Actualizado**: 24/03/2026  
**Perfil**: Agresivo controlado  
**Protección**: Máxima
