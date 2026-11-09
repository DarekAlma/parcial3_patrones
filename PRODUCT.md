# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + Vite + TypeScript (confirmado por el usuario). Build estático servido por nginx como un quinto workload en cada clúster EKS (dev, test, prod), desplegado por el mismo CD con canary. Cada ambiente apunta a su propio endpoint GraphQL del API Gateway.

## Users

- **Operador de flota / despachador** (usuario principal): coordina vehículos eléctricos de reparto urbano de última milla. Necesita saber dónde hay bahías libres ahora, reservar y activar una carga para un vehículo y confirmar que el cobro y la sesión quedaron bien o se revirtieron.
- **Evaluador técnico** (profesor en la sustentación en vivo): pide demostraciones en caliente. Fuerza fallos de la SAGA, cambia feature flags de un ambiente sin redesplegar y verifica que prod no cambia. La interfaz debe dejar visibles el ambiente activo, los pasos de la SAGA y las compensaciones.

## Product Purpose

AegisVolt es una plataforma B2B para operadores de flotas comerciales EV y administradores de electrolineras de carga rápida en Latinoamérica. Permite reservar bahías de carga, autorizar retenciones de saldo, activar sesiones de transferencia de energía y auditar la telemetría en tiempo real. Cada reserva es una transacción distribuida (SAGA) sobre tres microservicios. Hay éxito cuando el operador carga sin fricción y, si algo falla físicamente, el saldo y la bahía se restauran solos y de forma visible.

## Positioning

La reserva no es un formulario aislado: la UI muestra la transacción distribuida paso a paso (reserva → cobro → activación física) y, ante un fallo, cada compensación (reembolso → liberación de la bahía). La consistencia eventual se vuelve observable para el operador.

## Operating Context

- Ambientes estáticos `dev`, `test` y `prod`, cada uno con su API, sus datos y sus feature flags independientes.
- Feature flags reales: `ENABLE_DYNAMIC_SURGE_PRICING` (tarifa ×1.5 en horas pico), `ENABLE_FAST_CHARGE_BOOST` (reserva prioritaria de ultra-carga 350 kW) y `SIMULATE_CHARGER_HARDWARE_FAULT` (inyección de fallo para demostrar el rollback). La administración de flags está deshabilitada en prod.
- Estaciones de ejemplo en Bogotá, Medellín y Ciudad de México; flotas `fleet-andina`, `fleet-pacifico` y `fleet-caribe` (esta última con saldo bajo, para demostrar fondos insuficientes).
- Montos en centavos de USD; energía en kWh; potencia en kW.

## Capabilities and Constraints

Requisitos mínimos de UI (enunciado):
1. Panel de estado de electrolineras y disponibilidad de conectores en tiempo real.
2. Flujo de reserva y activación de carga (dispara la SAGA vía `reserveAndActivateCharge`).
3. Visualizador del estado de las feature flags según el ambiente.
4. Panel de historial de transacciones y estado de compensaciones ante fallos.

API GraphQL disponible: `environment`, `featureFlags`, `stations`, `telemetry`, `chargingSessions`, `wallets`, `quote`, `transactions`, `transaction`; mutations `reserveAndActivateCharge`, `setFeatureFlag`, `recoverTransaction` y `topUpWallet`. No hay subscriptions: el "tiempo real" se logra con polling. No hay autenticación de usuarios.

## Evidence on Hand

Datos reales del sistema (estaciones, conectores, telemetría simulada, billeteras, historial de SAGAs) servidos por la API. No existen clientes, testimonios, métricas comerciales ni precios reales: no se deben fabricar.

## Product Principles

1. El ambiente activo siempre es inequívoco: equivocarse entre dev y prod es el error más caro.
2. La transacción distribuida es visible: cada paso y cada compensación se muestra con su resultado real, nunca se resume en un "falló".
3. Estado vivo sobre estado estático: la disponibilidad y la telemetría se refrescan solas.
4. Las acciones peligrosas (flags de fallo) son explícitas y reversibles, y prod se protege.

## Accessibility & Inclusion

Interfaz en español. Contraste suficiente para proyectar en la sustentación. Los estados (disponible, reservado, cargando, fuera de servicio, compensado) no deben depender solo del color.
