---
name: AegisVolt
description: Patio de carga para flotas eléctricas, construido como surtidor de chapa esmaltada y ticket térmico.
colors:
  signal: "#f2c230"
  signal-deep: "#c99a12"
  signal-ink: "#1a1405"
  reverso: "#c8352a"
  reverso-bright: "#e2513f"
  env-test: "#2f7fb3"
  lcd-bg: "#0c1410"
  lcd-on: "#8df0a8"
  lcd-off: "rgba(141, 240, 168, 0.09)"
  lcd-dim: "#4f8a62"
  enamel: "#1d2b36"
  enamel-2: "#263845"
  enamel-3: "#33495a"
  enamel-edge: "#0f1820"
  enamel-ink: "#e8ecea"
  enamel-ink-2: "#a9b8c1"
  forecourt: "#c6ccc9"
  forecourt-joint: "#b3bab7"
  forecourt-ink: "#2b3439"
  paper: "#f3f0e8"
  ink: "#1b1b19"
  ink-faded: "#6a675f"
  paper-negative: "#141412"
  idle: "#7d8a90"
typography:
  display:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "clamp(26px, 3vw, 38px)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "0.005em"
  env-code:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "56px"
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: "-0.01em"
  lcd-xl:
    fontFamily: "'DSEG7', ui-monospace, monospace"
    fontSize: "clamp(46px, 6vw, 76px)"
    fontWeight: 700
    lineHeight: 1
  lcd-md:
    fontFamily: "'DSEG7', ui-monospace, monospace"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1
  title:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    letterSpacing: "0.03em"
  body:
    fontFamily: "'Barlow', system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  label:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    letterSpacing: "0.1em"
  ticket:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  tag: "4px"
  plate: "6px"
  key: "8px"
  glass: "10px"
  panel: "12px"
  body: "18px"
  crown: "28px"
spacing:
  seam: "1px"
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "22px"
  xl: "26px"
  gutter: "28px"
components:
  button-authorize:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    typography: "{typography.title}"
    rounded: "{rounded.panel}"
    height: "70px"
  key:
    backgroundColor: "{colors.enamel-3}"
    textColor: "{colors.enamel-ink}"
    typography: "{typography.title}"
    rounded: "{rounded.key}"
    padding: "10px 0 8px"
  key-on:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
  hose:
    backgroundColor: "{colors.enamel-2}"
    textColor: "{colors.enamel-ink}"
    padding: "14px 14px 12px"
  hose-chosen:
    backgroundColor: "{colors.enamel-3}"
  fleet-card:
    backgroundColor: "{colors.enamel-2}"
    textColor: "{colors.enamel-ink}"
    padding: "14px 14px 12px"
  fleet-card-on:
    backgroundColor: "{colors.enamel-3}"
  dispenser:
    backgroundColor: "{colors.enamel}"
    textColor: "{colors.enamel-ink}"
    rounded: "{rounded.body}"
    padding: "26px 28px 28px"
  lcd-glass:
    backgroundColor: "{colors.lcd-bg}"
    textColor: "{colors.lcd-on}"
    rounded: "{rounded.glass}"
    padding: "18px 22px 16px"
  ticket:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.ticket}"
    padding: "26px 22px 34px"
  ticket-negative:
    backgroundColor: "{colors.paper-negative}"
    textColor: "{colors.paper}"
  roll-item:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
    padding: "9px 12px"
  tier-tag:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.tag}"
    padding: "3px 10px 2px"
  env-sign:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.enamel}"
    rounded: "{rounded.plate}"
    padding: "12px 22px 14px"
---

# Design System: AegisVolt

## Overview

**Creative North Star: "Surtidor y ticket térmico"**

La interfaz es una estación de carga vista de cerca. Sobre un patio de concreto gris se levanta un surtidor de chapa esmaltada azul petróleo, con su franja amarilla de servicio, su vidrio LCD de siete segmentos en verde fósforo y su teclado de teclas físicas. A la derecha, una impresora entrega un ticket de papel térmico: ahí se lee cada transacción distribuida, renglón por renglón, y si falla aparece el sello rojo de REVERSO. Cada pieza de UI es un objeto del mundo (marquesina, placa colgada, manguera, llave de servicio, rollo de comprobantes), no una tarjeta genérica.

La densidad es de equipo de campo: mucha información en poco espacio, pero con rotulación condensada en mayúsculas, números tabulares y estados que siempre llevan forma y texto. El color se reserva para señal: el amarillo marca lo activo y lo accionable, el verde fósforo es la lectura viva, el rojo es reverso o peligro. El resto es chapa, concreto y papel.

El build rechaza el dashboard de tarjetas KPI con barra lateral. La transacción no se resume en un badge: se imprime.

**Key Characteristics:**
- Tres materiales con su propia tinta: chapa esmaltada (oscura), papel térmico (claro, monoespaciado), vidrio LCD (negro con dígitos DSEG7 y "8" fantasma debajo).
- Franjas gruesas de color como señal estructural: marquesina con borde inferior de ambiente (10px) y corona del surtidor con franja de servicio (8px).
- Estados con forma + texto, nunca solo color.
- Grupos de opciones como un solo panel dividido por costuras de 1px.
- Movimiento mecánico: pasos discretos (`steps()`), recorrido de tecla, avance del papel.

## Colors

Paleta restringida de materiales neutros (concreto, esmalte, papel) con tres tintas de señal: amarillo de servicio, verde fósforo y rojo de reverso.

### Primary
- **Amarillo de servicio** (signal): selección actual, acción primaria, foco (`outline` de 3px), franja de la corona del surtidor, etiqueta ULTRA, número de estación, texto de estado "ON" en el panel de servicio. También es el color de ambiente dev.
- **Amarillo de servicio profundo** (signal-deep): solo la pared inferior de las teclas encendidas y del botón AUTORIZAR.
- **Tinta sobre amarillo** (signal-ink): todo texto apoyado sobre amarillo.

### Secondary
- **Rojo de reverso** (reverso): compensaciones, errores de teclado, tachado de pasos compensados, placa y franja de ambiente prod, cuchilla de la llave de fallo encendida.
- **Rojo de sello** (reverso-bright): variante más clara del reverso para fondos oscuros y papel negativo: sello REVERSO, monto reversado en el rollo, marcas de comprobante fallido o compensado.

### Tertiary
- **Verde fósforo** (lcd-on): dígitos LCD encendidos, lámparas ON, conector disponible, saldo de flota, lámpara de señal en vivo.
- **Segmento apagado** (lcd-off): el "8" fantasma detrás de cada valor LCD.
- **Fósforo atenuado** (lcd-dim): rótulos y unidades dentro del vidrio, borde del indicador de tarifa en reposo.
- **Vidrio LCD** (lcd-bg): fondo de todo display.

### Neutral
- **Esmalte** (enamel): cuerpo del surtidor, marquesina, impresora, rollo, tablero de lámparas.
- **Esmalte 2** (enamel-2): superficies internas (mangueras, tarjetas de flota, surtidores en espera, puerta del panel de servicio).
- **Esmalte 3** (enamel-3): superficie elegida o en hover, teclas en reposo, divisores dentro de la chapa.
- **Borde de chapa** (enamel-edge): costuras de 1px entre opciones, bisel del vidrio, pista del interruptor.
- **Tinta de chapa** (enamel-ink) y **tinta de chapa secundaria** (enamel-ink-2): texto principal y secundario sobre esmalte.
- **Concreto** (forecourt), **junta** (forecourt-joint), **tinta de patio** (forecourt-ink): fondo de página con grano SVG y juntas de dilatación horizontales; texto directamente sobre el patio.
- **Papel térmico** (paper), **tinta** (ink), **tinta desvanecida** (ink-faded): ticket y rollo de comprobantes.
- **Papel negativo** (paper-negative): ticket y renglón del rollo cuando la transacción se reversó.
- **Reposo** (idle): lámpara y franja sin ambiente conocido.

### Ambiente
El color del ambiente vive en la variable `--env` de `.app` y solo pinta la franja inferior de la marquesina: dev = signal, test = env-test, prod = reverso, desconocido = idle. La placa de ambiente repite el código con su propio patrón: dev amarillo con cinta de peligro diagonal arriba, test claro con contorno interior azul oscuro, prod rojo con candado.

### Named Rules
**The Señal Escasa Rule.** El amarillo marca solo lo seleccionado, lo accionable o lo activo. Una superficie amarilla que no sea ninguna de esas tres cosas es un error.

**The Tres Tintas Rule.** Cada material tiene su tinta base: sobre chapa, enamel-ink; sobre papel, ink; sobre vidrio, lcd-on. Sobre chapa el verde fósforo aparece solo como luz (lámparas, marca de disponible, saldo de flota), nunca como texto corriente; sobre papel no aparece nunca.

**The Ambiente Inequívoco Rule.** El ambiente se anuncia con color, código, nombre y patrón a la vez. Nunca se distingue un ambiente solo por color.

## Typography

**Display Font:** Barlow Condensed (con Barlow, system-ui)
**Body Font:** Barlow (con system-ui)
**Label/Mono Font:** JetBrains Mono para el papel; DSEG7 Classic Bold para los displays.

**Character:** Barlow Condensed es la rotulación pintada del surtidor: mayúsculas, peso 700, tracking abierto en tamaños chicos. Barlow lleva la lectura corriente. JetBrains Mono es la cabeza térmica de la impresora. DSEG7 solo existe dentro del vidrio LCD o para cifras de potencia sobre chapa.

### Hierarchy
- **Display** (700, clamp(26px, 3vw, 38px), 1.05, mayúsculas): nombre de la estación en la corona del surtidor. Con `text-wrap: balance`.
- **Código de ambiente** (700, 56px, 0.9; 40px bajo 520px): DEV / TEST / PROD en la placa colgada. Único uso de ese tamaño.
- **LCD** (DSEG7 700; xl clamp(46px, 6vw, 76px), md 26px, sm 24px): lecturas del display. El valor se dibuja encima de un "8" fantasma del mismo ancho y se rellena con huecos para que los dígitos no bailen.
- **Title** (700, 22px, 0.03em, mayúsculas): encabezados de panel, número de manguera, teclas de energía, nombre del ambiente.
- **Body** (400, 16px, 1.45, cifras tabulares globales): texto corriente; textos secundarios a 13-15px.
- **Label** (Barlow Condensed 600-700, 12-14px, 0.06-0.1em, mayúsculas, enamel-ink-2 o lcd-dim): leyendas de grupo, rótulos de LCD, `dt` de la marquesina, encabezados de tabla, estado de manguera.
- **Ticket** (JetBrains Mono 400/700, 13px, 1.55): todo el papel; título del ticket a 22px, total a 18px, notas a 12px.

### Named Rules
**The Rótulo Condensado Rule.** Todo lo que en un surtidor real estaría pintado o serigrafiado (nombres, rótulos, estados, botones) va en Barlow Condensed mayúsculas. La prosa explicativa queda en Barlow en caja normal.

**The Fuente por Material Rule.** DSEG7 solo para lecturas numéricas de máquina; JetBrains Mono solo en papel, en identificadores técnicos (`code`) y en montos de saldo. Nunca DSEG7 para texto ni monoespaciada para rótulos de chapa.

## Layout

Contenedor de 1480px máximo con 28px de margen lateral (16px bajo 960px). La marquesina sangra a todo el ancho con márgenes negativos iguales al padding del contenedor.

El patio es una grilla 8fr / 4fr (mínimo 340px a la derecha) con 30px de separación: a la izquierda la fila de surtidores en espera (desplazamiento horizontal, columnas de mínimo 200px) y el surtidor grande; a la derecha la impresora, pegajosa a 18px del borde superior. Debajo, el panel de servicio en dos columnas iguales (puerta de llaves y tablero de lámparas).

El teclado del surtidor usa tres columnas (1.3fr 1fr 1fr) con 22px de separación. Las mangueras se reparten con `auto-fit` y mínimo 150px.

Puntos de quiebre: 1180px (teclado a 2 columnas con AUTORIZAR a lo ancho; panel de servicio a 1 columna), 960px (todo a una columna, impresora estática, mangueras a 2 columnas, placa de ambiente debajo de la marca), 520px (teclas de energía a 2 columnas, código de ambiente a 40px).

Ritmo de espaciado: 14px dentro de piezas, 22px entre grupos, 26px entre bloques del surtidor, 28px de margen de chapa.

### Named Rules
**The Panel Único Rule.** Opciones hermanas (mangueras, tarjetas de flota, llaves de servicio) viven en un solo panel con fondo enamel-edge y `gap: 1px`: la costura es el divisor. No se separan en tarjetas flotantes.

## Elevation & Depth

Sistema híbrido físico. Los cuerpos de chapa proyectan una sombra difusa hacia abajo sobre el concreto; el vidrio LCD se hunde con bisel doble y sombra interior; las teclas tienen pared inferior sólida que desaparece al presionarlas. El papel no tiene sombra propia: la impresora le aplica un `drop-shadow` para que el corte dentado la conserve.

### Shadow Vocabulary
- **Cuerpo de chapa** (`0 18px 30px -18px rgba(9, 16, 22, 0.55), 0 2px 0 rgba(255, 255, 255, 0.06) inset`): surtidor, impresora, rollo, puerta de servicio, tablero de lámparas.
- **Pared de tecla** (`0 3px 0 var(--enamel-edge), 0 6px 10px -6px rgba(0, 0, 0, 0.6)`): teclas de energía; en el botón AUTORIZAR la pared es de 5px en signal-deep. En `:active` la tecla baja exactamente lo que mide la pared y la pared se anula.
- **Vidrio hundido** (`0 0 0 4px var(--enamel-edge), 0 0 0 6px var(--enamel-3), inset 0 10px 18px -12px rgba(0, 0, 0, 0.9)`): display principal.
- **Placa colgada** (`0 14px 22px -12px rgba(9, 16, 22, 0.55)`): placa de ambiente.
- **Papel** (`drop-shadow(0 12px 14px rgba(9, 16, 22, 0.35))`): salida de la impresora.

### Named Rules
**The Pared con Recorrido Rule.** Una sombra sólida sin desenfoque solo existe como pared inferior de una tecla que se puede presionar y cuyo `:active` la consume con un `translateY` igual. Nunca como decoración ni con desplazamiento horizontal.

**The Selección sin Raya Rule.** La selección dentro de un panel se marca cambiando a enamel-3 más una línea interior: `inset 0 3px 0` signal en la manguera, `inset 0 0 0 1px` signal en la tarjeta de flota. Nada de rayas laterales gruesas.

## Shapes

Radios de chapa estampada: el cuerpo del surtidor tiene corona más redonda (28px) que su base (18px); los surtidores en espera repiten la idea (12px arriba, 6px abajo). Paneles internos a 10-12px, teclas a 8px, placas y renglones a 6px, etiquetas a 3-4px. Las lámparas y marcas de disponibilidad son círculos; las demás marcas de estado son cuadrados de 12-14px.

El papel termina en borde dentado (máscara cónica de 16px × 10px). El sello REVERSO gira -3°. Las bandas de peligro son diagonales a -45° (cinta de la placa dev, manguera fuera de servicio) o cónicas (anillo de la llave de fallos).

## Components

### Buttons
Teclas físicas, no botones web.
- **Shape:** tecla de 8px; botón AUTORIZAR de 12px y 70px de alto mínimo.
- **Primary (AUTORIZAR Y CARGAR):** degradado de #ffd75a a signal, texto signal-ink, Barlow Condensed 700 clamp(18px, 1.55vw, 24px) en mayúsculas sin cortar, icono de rayo de 20px.
- **Tecla de energía:** enamel-3 con cifra a 22px y unidad `small` a 11px; encendida pasa al degradado amarillo con pared signal-deep y `aria-pressed`.
- **Hover / Focus:** foco global `outline: 3px solid` signal con 3px de separación. `:active` hunde la tecla (0.12s).
- **Disabled:** AUTORIZAR usa `filter: grayscale(0.85) brightness(0.7)` y cursor `not-allowed`.

### Chips
- **Etiqueta de tarifa:** borde 1px lcd-dim, texto lcd-dim en mayúsculas; con hora pico pasa a fondo signal y texto signal-ink.
- **Etiqueta ULTRA / número de estación:** fondo signal, texto signal-ink, 3-4px de radio, 12-15px con tracking 0.06-0.08em.

### Cards / Containers
- **Corner Style:** cuerpo 18px (corona 28px en el surtidor).
- **Background:** enamel o enamel-2.
- **Shadow Strategy:** cuerpo de chapa (ver Elevation & Depth).
- **Border:** ninguno; la división interna es `border-top: 1px solid` enamel-3 o la costura de 1px.
- **Internal Padding:** 24-28px; 16-20px bajo 960px.

### Inputs / Fields
- **Radios como tarjetas de flota:** input oculto, `label` completo clicable, foco con `:focus-within` y anillo amarillo de 3px. Saldo en JetBrains Mono 700 verde fósforo.
- **Interruptor de ultra-carga:** pista de 56 × 30px enamel-edge con sombra interior; perilla de 24px con icono (llave si está habilitado, candado si la flag está apagada). Encendido: la perilla se desliza 26px y se vuelve signal.
- **Llave de servicio:** dial circular de 58px con cuchilla que gira de -45° a 45° (0.35s, ease-out); leyenda off/ON debajo. La llave de fallos lleva anillo cónico amarillo y negro, y encendida tiñe su fila de #3a1612.

### Navigation
- **Marquesina:** franja enamel a todo el ancho con wordmark (Barlow Condensed 700, 34px, "Volt" en signal), placa de ambiente colgada al centro con dos varillas punteadas, y `dl` de versión / pista / señal a la derecha. Borde inferior de 10px en color de ambiente. Bajo 960px apila marca, placa y metadatos.
- **Fila de surtidores:** botones enamel-2 con nombre, ciudad, LCD chico de conectores libres y marcas de mangueras; el seleccionado pasa a enamel, sube 3px y es el único con el LCD encendido (los demás al 40%).

### Display LCD
Signature. Vidrio negro, rótulo arriba en lcd-dim, dígitos DSEG7 en lcd-on con "8" fantasma en lcd-off detrás, unidad a la derecha. Valores con ancho fijo. Lecturas en vivo cuando una manguera carga; si no, cotización.

### Manguera
Botón con rol radio dentro del panel de mangueras: pistola dibujada (CCS2 o CHAdeMO, 40px), número a 22px, potencia en DSEG7 16px, marca de estado y texto. Fuera de servicio lleva rayado diagonal y queda deshabilitada.

### Marcas de estado
Forma + texto siempre. Disponible: círculo fósforo. Reservado: cuadrado hueco amarillo. Cargando: barras fósforo que fluyen con contorno. Fuera de servicio: aspa roja. En papel (pasos de SAGA y rollo): cuadrado lleno = ok, punteado = pendiente, parpadeo por pasos = en curso, aspa roja = fallido, barra roja horizontal = compensado, doble borde rojo = compensación fallida.

### Ticket térmico
Signature. Papel con cabecera centrada, renglones `dt/dd` con rótulo a la izquierda en tinta desvanecida y valor a la derecha, separadores discontinuos con título centrado, pasos de SAGA con marca, nombre, tiempo y estado, total a 18px, código de barras y correlation_id. Al imprimir avanza en 26 pasos (1.5s) desde la ranura. Si la transacción se reversó, el papel pasa a negativo y aparece el bloque REVERSO con borde superior rojo de 2px y sello girado.

### Tablero de lámparas
Tabla enamel con una fila por flag y una columna por ambiente; la columna del ambiente actual se tiñe con amarillo al 10%. Lámpara: círculo de 14px con texto en mayúsculas sin cortar. ON = fósforo lleno; off = anillo; sin señal = anillo tachado con una diagonal; sin endpoint = anillo tenue.

## Do's and Don'ts

### Do:
- **Do** convertir cada pieza nueva en un objeto del surtidor, la impresora o el patio antes de dibujarla.
- **Do** acompañar cada estado con forma y texto; el color solo refuerza.
- **Do** mostrar lecturas numéricas de máquina en el vidrio LCD con "8" fantasma y ancho fijo.
- **Do** agrupar opciones hermanas en un panel con costuras de 1px enamel-edge.
- **Do** usar `outline: 3px solid` signal para todo foco visible.
- **Do** animar con pasos mecánicos (`steps()`) o con `cubic-bezier(0.16, 1, 0.3, 1)`, y respetar `prefers-reduced-motion`.
- **Do** imprimir en el ticket cada paso y cada compensación con su resultado real.

### Don't:
- **Don't** construir paneles de tarjetas KPI con barra lateral.
- **Don't** marcar selección con una raya lateral gruesa; usa enamel-3 más línea interior.
- **Don't** usar amarillo en superficies que no estén seleccionadas, activas o accionables.
- **Don't** poner sombras sólidas sin desenfoque en elementos que no se presionan.
- **Don't** usar rótulo condensado impreso en el papel (el sello REVERSO es tinta de sello, no de impresora) ni monoespaciada para rótulos de chapa.
- **Don't** distinguir ambientes solo por color.
