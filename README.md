# realbot · Bot de trading automatizado

Bot de trading sobre la API de **Binance**, desarrollado en Node.js como ejercicio de
aprendizaje. Incluye panel web, registro de operaciones en SQLite y varias estrategias
configurables.

> **Entorno de pruebas.** El bot se desarrolló contra la red de pruebas de Binance
> (*testnet*). No opera con fondos reales ni se recomienda usarlo para ello.

## Estrategias implementadas

Escalpeo, operativa de posición, ruptura de rango, momento, reversión a la media y
seguimiento de tendencia; cada una se activa por separado desde la configuración.

## Gestión de riesgo

Porcentaje de riesgo por operación, objetivo de beneficio y parada basados en el rango medio
verdadero, número máximo de posiciones abiertas, límite diario de operaciones y máxima caída
tolerada.

## Configuración

Las credenciales y los parámetros se toman de variables de entorno; **no se versionan**.
Se necesitan `BINANCE_API_KEY` y `BINANCE_API_SECRET` de la red de pruebas.

```bash
npm install
node bot.js
```

El panel queda en `http://localhost:3000`.

---
Autor: Nicolás Ángel Rojas Yáñez · [github.com/Nico1091](https://github.com/Nico1091)
