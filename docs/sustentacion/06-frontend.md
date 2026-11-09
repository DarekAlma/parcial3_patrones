# Capa 5 — Frontend web (8%)

## Mapa rápido

| Qué | Dónde |
|-----|-------|
| Contrato de diseño (dirección visual) | primer comentario del `<body>` en [frontend/index.html](../../frontend/index.html) |
| Producto y usuarios | [PRODUCT.md](../../PRODUCT.md) |
| Composición de la pantalla | [frontend/src/App.tsx](../../frontend/src/App.tsx) |
| a) Estado de electrolineras y conectores en tiempo real | [StationRail.tsx](../../frontend/src/components/StationRail.tsx), [Dispenser.tsx](../../frontend/src/components/Dispenser.tsx) |
| b) Reserva y activación (dispara la SAGA) | [Dispenser.tsx](../../frontend/src/components/Dispenser.tsx) → `reserveAndActivateCharge` |
| c) Feature flags por ambiente | [ServiceCabinet.tsx](../../frontend/src/components/ServiceCabinet.tsx) |
| d) Historial y estado de compensaciones | [Ticket.tsx](../../frontend/src/components/Ticket.tsx), [TicketRoll.tsx](../../frontend/src/components/TicketRoll.tsx) |
| Operaciones GraphQL (validadas en CI contra el esquema) | [frontend/src/graphql/](../../frontend/src/graphql/) |
| Cliente GraphQL + polling | [frontend/src/lib/graphql.ts](../../frontend/src/lib/graphql.ts) |
| Imagen nginx sin privilegios | [frontend/Dockerfile](../../frontend/Dockerfile), [nginx.conf](../../frontend/nginx.conf) |
| Manifiestos (stable + canary, NodePort 30081) | [k8s/base/frontend.yaml](../../k8s/base/frontend.yaml) |
| Rutas `GET /` del API Gateway → NLB → frontend | [infra/terraform/modules/api-gateway/frontend.tf](../../infra/terraform/modules/api-gateway/frontend.tf) |

## Cómo llega el navegador a la UI de cada ambiente

```
Navegador ─► http://<apiId-del-ambiente>.execute-api.localhost.floci.io:4566/
             API Gateway (HTTP API del ambiente)
               ├─ GET /, GET /{proxy+}       ─► VPC Link ─► NLB listener 1809X ─► NodePort 30081 ─► nginx (frontend)
               └─ ANY /graphql, /health, /flags ─► VPC Link ─► NLB listener 1808X ─► NodePort 30080 ─► graphql-gateway
```

- La UI y `/graphql` comparten **origen**: no hay CORS y no hay URLs de API quemadas en el build. La misma imagen del frontend sirve a dev, test y prod, y **cada UI habla con el GraphQL de su propio ambiente**.
- El frontend también tiene canary (stable 4 + canary 0). Su gate cuenta las requests y los 5xx en los *access logs* del pod canary, porque nginx no publica métricas en CloudWatch.
- `deploy.ps1` escribe en el ConfigMap `frontend-config` las URLs de los tres API Gateway. La UI las usa **solo para leer** las flags de los otros ambientes y mostrarlas al lado.

URLs actuales (cambian si se recrea la infra; las imprime el *Job Summary* de `k8s-apply`):
```powershell
aws apigatewayv2 get-apis --query "Items[].{ambiente:Name,url:ApiId}" --output table
# UI = http://<ApiId>.execute-api.localhost.floci.io:4566/
```

## Diseño: «Surtidor y ticket térmico»

El diseño se hizo con la skill **impeccable**:
1. Se definió el producto en PRODUCT.md.
2. El mundo visual se derivó de la cultura del usuario: siete candidatos ordenados por resonancia, y un sorteo con semilla para no caer en el dashboard genérico.
3. El usuario eligió entre las alternativas.
4. El build pasó un detector de anti-patrones y una revisión final independiente.

| Elemento del mundo | Qué representa en el producto |
|--------------------|-------------------------------|
| **Surtidor** (chapa esmaltada, franja amarilla) | Una electrolinera. La seleccionada ocupa el escenario; las demás esperan en la fila de arriba con su display de conectores libres |
| **Display LCD de 7 segmentos** | Cotización en vivo (aplica la tarifa dinámica) y, durante una carga, la telemetría real: kW, kWh, % de batería, V y °C |
| **Mangueras** | Los conectores. Cada estado tiene **forma + texto**, no solo color: círculo = libre, recuadro = reservado, barras en movimiento = cargando, X = fuera de servicio |
| **Teclado** | Tarjeta de flota, energía (10/20/40/60 kWh), interruptor de ultra-carga (bloqueado si la flag está apagada) y **AUTORIZAR Y CARGAR** |
| **Ticket térmico** | La SAGA: un renglón por paso con su tiempo exacto. Si la SAGA se revierte, el ticket se imprime **en negativo** con el sello **REVERSO**, los pasos revertidos tachados y las compensaciones en orden |
| **Rollo de comprobantes** | Historial de transacciones; los revertidos se ven en negativo |
| **Panel de servicio** | Flags con llave de mantenimiento (bloqueado en prod) y tablero de lámparas con la misma flag en dev, test y prod |
| **Placa de ambiente** | DEV amarilla con franjas de peligro, TEST blanca con marco azul, PRODUCCIÓN roja con candado: es imposible confundir el ambiente |

---

## Pregunta guía

### Cambie el estado de una Feature Flag en `dev` sin redesplegar el código y muestre cómo cambia el comportamiento en el Frontend web de `dev` mientras `prod` permanece intacto.

**Respuesta corta:**
1. En la UI de **dev**, giro la llave de `ENABLE_FAST_CHARGE_BOOST` en el panel de servicio. Esto ejecuta la mutation `setFeatureFlag`, que escribe en `aegisvolt-feature-flags-dev`.
2. En ≤ 3 s, sin redesplegar ni reiniciar nada (cache de flags de 3 s en los pods), el interruptor **«Ultra-carga prioritaria 350 kW»** del teclado de dev cambia de bloqueado a disponible. Una reserva prioritaria ahora usa el conector **Ultra (C3)**; antes la SAGA respondía `FEATURE_DISABLED`.
3. En la misma pantalla, el tablero de lámparas muestra la flag cambiada en **DEV** y sin cambios en **PROD**. En la UI de **prod** la llave está bloqueada (`FLAG_ADMIN_ENABLED=false`) y el comportamiento no cambia.

**Paso a paso (demo):**

| # | Acción | Qué se ve |
|---|--------|-----------|
| 1 | Abrir la UI de dev y la de prod en dos pestañas | Placa **DEV** amarilla y placa **PRODUCCIÓN** roja |
| 2 | En dev, panel de servicio: girar **Ultra-carga prioritaria** a ON | La llave gira, el texto pasa a «Reservas prioritarias en conectores de 350 kW», y la lámpara DEV se enciende mientras **PROD sigue en off** |
| 3 | En el teclado de dev: activar «Ultra-carga prioritaria 350 kW» y autorizar | Ticket **completado** en la manguera **C3 · ULTRA** (350 kW) |
| 4 | Apagar la flag en dev e intentar de nuevo | El interruptor se bloquea («Apagada en este ambiente») |
| 5 | En la UI de prod | La llave está bloqueada con candado y ningún comportamiento cambió |

**Variante con la tarifa dinámica:** con `ENABLE_DYNAMIC_SURGE_PRICING` en ON y en hora pico (7–10 y 17–21, hora de Bogotá), el LCD muestra «HORA PICO ×1.5» y la tarifa sube de US$ 0,35 a US$ 0,53/kWh. Fuera de hora pico muestra «Tarifa dinámica · fuera de pico».

**Variante con la falla de hardware:** con `SIMULATE_CHARGER_HARDWARE_FAULT` en ON, la siguiente carga imprime el ticket en negativo con **REVERSO**: «El cargador reportó una falla física», luego «Reembolso a la billetera · reembolsado» y «Liberación de la bahía · liberada». El saldo de la tarjeta de flota no cambia.

**Alternativa sin UI** (para mostrar que el cambio es solo de datos):
```powershell
aws dynamodb update-item --table-name aegisvolt-feature-flags-dev `
  --key '{\"flag\":{\"S\":\"ENABLE_FAST_CHARGE_BOOST\"}}' `
  --update-expression "SET enabled = :t" --expression-attribute-values '{\":t\":{\"BOOL\":true}}'
aws dynamodb get-item --table-name aegisvolt-feature-flags-prod `
  --key '{\"flag\":{\"S\":\"ENABLE_FAST_CHARGE_BOOST\"}}' --query Item.enabled
```

**Por qué no hace falta redesplegar:**
- Las flags **no** están en el código ni en el ConfigMap: viven en DynamoDB, en una tabla por ambiente.
- Cada pod las lee con `FeatureFlagClient`, que usa una cache de 3 s ([packages/common/src/flags.ts](../../packages/common/src/flags.ts)).
- La UI consulta `featureFlags` cada 4 s.
- La imagen y el ConfigMap no cambian, así que no hay rollout.

---

## Otras preguntas probables

**¿Cómo es "tiempo real" si no hay WebSockets?** Con polling de GraphQL: estaciones cada 3 s, telemetría de la estación seleccionada cada 2 s, flags cada 4 s e historial cada 5 s. El polling se pausa con la pestaña oculta. La API Gateway HTTP API no soporta suscripciones GraphQL; con una WebSocket API de API Gateway se podría migrar sin cambiar la UI, porque los componentes consumen hooks.

**¿Cómo muestra la UI una compensación?** El ticket de la SAGA trae `steps` y `compensations` reales del log de la SAGA. Cada paso revertido aparece tachado, la falla aparece con su marca X y el comprobante de **REVERSO** lista cada compensación con su resultado (`reembolsado`, `liberada`, `ya reembolsado`…) y su hora. Todo el ticket se invierte a negativo para que el rollback sea inconfundible, incluso proyectado.

**¿La UI depende del color para los estados?** No. Cada estado tiene forma (círculo, recuadro, barras, X, tachado) y texto (LIBRE, RESERVADO, CARGANDO, FUERA DE SERVICIO; ok, revertido, falló). Los colores solo refuerzan.

**¿Cómo se asegura que la UI no rompe el contrato GraphQL?** Las operaciones viven en archivos `.graphql` y el job `lint-build` las valida contra el esquema del gateway (`npm run graphql:validate`). Además el CI hace typecheck y build de la UI y construye su imagen.

**¿Qué seguridad tiene el contenedor?**
- Usa `nginx-unprivileged` (usuario 101, puerto 8080).
- `readOnlyRootFilesystem` con `emptyDir` en `/tmp`, sin capacidades y con `seccomp RuntimeDefault`.
- Envía los headers `X-Content-Type-Options` y `Referrer-Policy`.
- Los assets llevan hash de contenido y cache inmutable; `index.html` y la config de runtime van sin cache.
