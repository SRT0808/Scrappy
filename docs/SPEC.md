# Scrappy: especificación técnica

*Documento para el agente de desarrollo · v1.0 · 8 de octubre de 2026*

## 0. Cómo usar este documento

Este documento es la **única fuente de contexto** del proyecto: el agente no ha visto la conversación donde se definió. Reglas de trabajo:

- Lo marcado como **Decidido** no se cambia sin consultar al dueño. Lo marcado como **Validar** debe comprobarse de forma empírica y reportarse.
- Trabajar por fases (sección 14). Al terminar cada fase, detenerse y presentar resultados contra los criterios de aceptación antes de continuar.
- No añadir funcionalidades fuera de alcance (sección 3) ni servicios de pago.
- Los detalles de los planes gratuitos (Vercel, Supabase, GitHub Actions, ntfy, Healthchecks) pueden haber cambiado: verificarlos en la documentación oficial al implementar y reportar discrepancias.
- Convenciones: código, commits y documentación técnica en inglés; interfaz y mensajes de notificación en español. Registrar las decisiones relevantes en `docs/decisions.md`.

## 1. Objetivo y principio rector

**Scrappy** es una herramienta **personal y 100% gratuita** que vigila el precio de productos de **cualquier tienda online** (Amazon, Mercado Libre, Falabella, Ripley, tiendas pequeñas o locales, etc.) a partir de su URL, y avisa al celular del dueño cuando el precio llega a la meta que él definió.

**Problema:** hoy, enterarse de un descuento exige suscribirse a newsletters (que anuncian campañas, no el producto concreto que uno quiere) o entrar a la tienda una y otra vez.

**Ejemplo:** un producto cuesta S/ 1,000 sin descuento. El dueño quiere que Scrappy le avise cuando llegue a S/ 800, o lo que es equivalente, a un 20% de descuento.

**Principio rector:** la **notificación es el producto**. El dueño no debe necesitar abrir la app para enterarse de una oferta. La interfaz web es el panel de control (registrar, organizar, ver historial y tendencias), no el mecanismo de aviso.

## 2. Restricciones (Decidido)

- **Costo cero:** solo software open source y capas gratuitas.
- **Un único usuario** (el dueño). Sin registro, roles ni multiusuario.
- **Sin servidores propios** ni infraestructura pesada.
- **Agnóstico a la tienda:** ningún adaptador obligatorio por tienda y ninguna API específica de tienda (ni Amazon, ni Mercado Libre, ni Keepa). Debe funcionar con cualquier URL de producto que exponga nombre y precio. Si una tienda no puede leerse, el sistema lo dice con claridad en lugar de fallar en silencio.
- Tras registrar un producto, el monitoreo y los avisos son **100% automáticos**.
- **Bajo volumen:** decenas de productos y revisiones cada 3 horas o más, para minimizar bloqueos. El scraping puede contravenir los términos de servicio de algunas tiendas; el dueño asume ese riesgo para su uso personal.

## 3. Alcance

**Dentro de la v1:**

- Registrar productos por URL, con extracción de nombre, precio, moneda e imagen, y pantalla de confirmación.
- Múltiples listas de productos.
- Condición de alerta por precio objetivo o por porcentaje de descuento.
- Revisión automática periódica con historial de precios.
- Gráficos de historial y tendencias.
- Notificaciones push (ntfy) y por correo (Gmail SMTP).
- Alertas de fallo de lectura, de precio sospechoso y de caída del sistema.
- Acceso protegido con clave simple. Web instalable como PWA.

**Fuera de la v1:** cuentas y multiusuario, búsqueda por nombre de producto, APIs por tienda, app móvil nativa, WhatsApp, servidor propio, comparación entre tiendas, extensión de navegador. Ver backlog (sección 17).

## 4. Flujo de usuario

1. El dueño abre Scrappy e ingresa su clave de acceso.
2. Pulsa **Añadir producto** y pega la URL.
3. Se dispara una lectura inmediata (workflow\_dispatch de GitHub Actions). La UI muestra progreso y consulta el resultado en la base de datos.
4. La UI muestra una **tarjeta de confirmación**: nombre, imagen, precio, moneda, método de extracción usado y nivel de confianza. Si la lectura falló o es ambigua, muestra hasta 5 precios candidatos con su texto de contexto para elegir, o un campo para pegar un selector CSS.
5. El dueño confirma o edita el **precio de referencia** (el «precio sin descuento»). Por defecto es el precio detectado; si la tienda expone un precio original o tachado, se sugiere ese.
6. Elige una lista, define la condición y el intervalo:
   - Precio objetivo en la moneda del producto, o porcentaje de descuento sobre la referencia. La UI muestra siempre el equivalente del otro.
   - Intervalo de revisión: 3, 6, 12 o 24 horas (por defecto 6).
7. Guarda. El producto pasa a estado `active`.
8. Cada 3 horas el cron revisa los productos que toquen, guarda el historial y evalúa la condición.
9. Si se cumple, llega una notificación push y un correo, una sola vez según la máquina de estados (sección 9).
10. Si no se puede leer, si el precio es sospechoso o si el sistema deja de correr, llega una alerta distinta.

## 5. Arquitectura

```
Navegador / PWA (React, Vercel)
      │ HTTPS + cookie de sesión
      ▼
Vercel Functions (/api, TypeScript) ──► Supabase (Postgres) ◄── Scraper Python (GitHub Actions)
      │ workflow_dispatch (API de GitHub)                          │
      └───────────────────────────────► GitHub Actions ────────────┤
                                                                   ├─► ntfy.sh (push al celular)
                                                                   ├─► Gmail SMTP (correo)
                                                                   └─► Healthchecks.io (latido)
```

Decisiones de arquitectura (Decidido, salvo que se marque Validar):

- El navegador **nunca** habla con Supabase ni conoce sus llaves. Solo habla con `/api`, que valida la sesión y usa la `service_role key` en el servidor. RLS activado en todas las tablas, sin políticas públicas.
- **Todo el scraping y todas las notificaciones viven en un único paquete Python** (`scraper/`). La web solo escribe datos y dispara workflows (registro, «revisar ahora», «notificación de prueba»). Así no se duplica lógica en dos lenguajes.
- El paquete Python debe poder ejecutarse por CLI **sin depender de GitHub Actions**, para correrlo en la PC o en una Raspberry del dueño si las IPs de centro de datos de Actions son bloqueadas por las tiendas (plan B). Usa el mismo Supabase.
- Todo el estado persistente está en Supabase. El runner de Actions es efímero y no hace commits al repositorio.
- Las funciones de Vercel solo hacen CRUD, sesión y dispatch (operaciones rápidas). **No** ejecutar scraping ni navegadores en Vercel.

## 6. Stack

| Capa | Tecnología | Notas |
| --- | --- | --- |
| Web | React + Vite + TypeScript | SPA, PWA con `vite-plugin-pwa` |
| UI | Tailwind CSS + shadcn/ui + Lucide + Motion | Tema oscuro minimalista |
| Estado y rutas | TanStack Query + React Router |  |
| Gráficos | Recharts |  |
| Backend ligero | Vercel Functions (TypeScript, carpeta `/api`) | CRUD, sesión, dispatch |
| Hosting web | Vercel, plan Hobby | Uso personal no comercial, despliegue desde GitHub |
| Base de datos | Supabase Postgres, capa gratuita | **Validar** pausa por inactividad; el scraper escribe en cada ejecución |
| Scraper | Python 3.11+ y Scrapling (versión fijada) | Ver nota abajo |
| Cliente DB (Python) | `supabase-py` o `httpx` contra PostgREST |  |
| Programación | GitHub Actions (cron y workflow\_dispatch) | Repositorio privado |
| Push | ntfy.sh |  |
| Correo | Gmail SMTP con contraseña de aplicación |  |
| Latido | Healthchecks.io | **Validar** plan gratuito vigente |

**Sobre Scrapling** (github.com/D4Vinci/Scrapling, licencia BSD-3, Python 3.10 o superior): framework de scraping con tres niveles de obtención de páginas (`Fetcher` HTTP con huella TLS de navegador, `DynamicFetcher` con navegador Playwright, `StealthyFetcher` con técnicas anti-detección que según su README resuelve Cloudflare Turnstile) y un parser con modo adaptativo que relocaliza elementos si cambia el HTML. Instalación: `pip install "scrapling[fetchers]"` y luego `scrapling install` para descargar navegadores. Sigue en versión 0.x, así que **fijar la versión exacta**. No usar su módulo de Spiders (innecesario). **Validar:** que superar Cloudflare no implica superar el anti-bot propio de Amazon u otras tiendas.

## 7. Modelo de datos (Supabase)

Todas las tablas con RLS activado y sin políticas públicas. Migraciones versionadas en `supabase/migrations/`. Precios como `numeric(12,2)`; monedas en ISO 4217.

- **lists:** `id`, `name`, `emoji`, `position`, `created_at`.
- **products:** `id`, `list_id`, `url`, `domain`, `name`, `image_url`, `currency`, `reference_price`, `target_type` (`price` o `percent`), `target_price`, `target_percent`, `check_interval_hours` (3, 6, 12 o 24), `status` (`pending_confirmation`, `active`, `paused`, `error`), `last_price`, `last_checked_at`, `last_success_at`, `consecutive_failures`, `alert_state` (`armed` o `triggered`), `last_alert_price`, `last_alert_at`, `last_method`, `created_at`.
- **price\_checks:** `id`, `product_id`, `checked_at`, `ok`, `price`, `currency`, `method`, `confidence`, `error_code`, `warnings` (jsonb). Una fila por intento, exitoso o no.
- **domain\_recipes:** `domain` (clave), `fetch_mode` (`http`, `dynamic` o `stealth`), `price_selector`, `name_selector`, `adaptive_state` (según lo que resulte viable al validar la persistencia de Scrapling), `updated_at`.
- **notifications:** `id`, `product_id` (nulo si es de sistema), `type`, `channel` (`ntfy` o `email`), `status` (`sent` o `failed`), `payload` (jsonb), `error`, `sent_at`.
- **runs:** `id`, `started_at`, `finished_at`, `trigger` (`cron`, `dispatch` o `local`), `checked`, `ok_count`, `fail_count`.
- **login\_attempts:** `ip`, `attempted_at`, `success`. Para limitar intentos de acceso.
- **settings:** `key`, `value` (jsonb). Intervalo por defecto, umbrales de validación y similares.

## 8. Extractor universal (el corazón técnico)

Objetivo: dada **cualquier URL de producto**, devolver nombre, precio y moneda sin código específico por tienda.

### 8.1 Capa de obtención de la página

Escalar solo si hace falta: `Fetcher` (HTTP con huella de navegador) → `DynamicFetcher` (navegador) → `StealthyFetcher` (anti-detección). Se considera que hay que escalar si la respuesta es un bloqueo (403, 429, página de desafío) o si el HTML llega sin precio. El modo que funcionó se recuerda por dominio en `domain_recipes.fetch_mode`. Pausas aleatorias de 2 a 8 segundos entre peticiones, alternando dominios, con timeouts razonables y reintentos limitados.

### 8.2 Estrategias de extracción, en orden

Se prueba cada una hasta obtener un resultado confiable:

1. **JSON-LD** (`script type=application/ld+json`): manejar `@graph`, arreglos y anidamiento; buscar `Product` o `ProductGroup`; leer `offers` (`Offer` o `AggregateOffer` con `lowPrice`), `price`, `priceCurrency`, `priceSpecification`, `availability`. Con varias ofertas, elegir la más baja disponible o marcar ambigüedad.
2. **Metaetiquetas y microdatos:** `og:price:amount`, `product:price:amount`, `product:price:currency`, `itemprop=price` (atributo `content`), entre otros.
3. **Receta del dominio:** selector CSS guardado en `domain_recipes` (aprendido del dueño). Con el modo adaptativo de Scrapling como red de seguridad si se valida su persistencia.
4. **Heurística sobre el contenido visible:** nombre desde el `h1` o el título; precio como el valor monetario más prominente cerca de elementos con nombre de clase o atributo relacionado con precio. Excluir cuotas («12 cuotas de», «/mes»), precios tachados, envío e impuestos, y productos relacionados. Devolver una lista de candidatos con puntaje.
5. **Enseñar una vez:** si todo falla o hay ambigüedad, la UI muestra hasta 5 candidatos con su contexto, o permite pegar un selector CSS. La elección se guarda como receta del dominio. No se incrusta la página de la tienda en la UI (bloqueo por CORS y X-Frame-Options).

### 8.3 Contrato de salida

Cada extracción devuelve: `name`, `price`, `currency`, `original_price` (opcional, solo como sugerencia de referencia, nunca para calcular descuentos), `image_url` (opcional), `availability` (opcional), `method` (estrategia usada), `confidence` (0 a 1), `candidates` (lista) y `warnings` (lista).

### 8.4 Normalización de precios

- Soportar formatos como `S/ 1,999.00`, `1.999,00`, `$1 999` y `USD 29.99`. Determinar el separador decimal por contexto (el último separador seguido de 1 o 2 dígitos es decimal).
- Moneda: preferir `priceCurrency` de los datos estructurados. Mapear símbolos (`S/` → PEN, `€` → EUR). Un `$` es ambiguo: resolver con la moneda estructurada, el dominio o el idioma de la página; si sigue ambiguo, pedir confirmación al dueño en la UI.
- Rechazar precios menores o iguales a cero.

### 8.5 Validación en cada revisión

- La moneda debe coincidir con la registrada; si cambia, marcar como sospechoso.
- Si el precio varía más de un porcentaje configurable (por defecto 50%) respecto al último válido, **no** disparar alerta de meta: hacer una segunda lectura tras unos segundos; si coincide, aceptarla, y si no, tratarla como lectura sospechosa.
- Si la disponibilidad indica agotado, registrar el precio pero no disparar alerta de meta (configurable).

## 9. Motor de revisión y alertas

**Selección de productos:** en cada ejecución, procesar los productos `active` cuyo `last_checked_at` más el intervalo ya haya vencido. El cron corre cada 3 horas, por lo que los intervalos son múltiplos de 3 h.

**Cálculo de meta:**

- Descuento % = (precio de referencia − precio actual) / precio de referencia × 100.
- Si el tipo es `percent`, el precio objetivo derivado = referencia × (1 − porcentaje/100).
- La condición se cumple si el precio actual es menor o igual al precio objetivo.

**Máquina de estados de alerta (evita repeticiones):**

- `armed` → `triggered`: al cumplirse la condición, enviar la notificación de meta. Solo pasar a `triggered` si **al menos un canal** confirmó el envío; si ambos fallan, reintentar en la siguiente ejecución.
- Estando en `triggered`: no volver a avisar mientras la condición se mantenga, salvo que el precio baje al menos un 5% adicional respecto a `last_alert_price` (aviso «bajó aún más»).
- `triggered` → `armed`: cuando el precio supere el objetivo en más de 3%.

**Fallos de lectura:** incrementar `consecutive_failures`. Al llegar a 3, enviar **una** alerta de fallo y pasar el producto a `error` (se sigue reintentando). Repetir el recordatorio como máximo cada 7 días. Un éxito reinicia el contador.

**Registro:** cada ejecución escribe una fila en `runs`, y cada intento en `price_checks`.

## 10. Notificaciones

Son la función más importante del proyecto: tienen que ser claras, fiables y accionables.

### 10.1 Canales (Decidido)

- **Principal: ntfy.** Servicio push gratuito. El dueño instala la app ntfy en el celular y se suscribe a un tema. El scraper publica un mensaje en ese tema y ntfy lo entrega como notificación push normal, aunque la app esté cerrada. No requiere cuenta. El nombre del tema actúa como contraseña: debe ser largo y aleatorio (24 caracteres o más) y guardarse como secreto (`NTFY_TOPIC`). Publicar en formato **JSON** (POST a la raíz del servidor con `topic`, `title`, `message`, `priority`, `tags` y `click`) para evitar problemas de codificación de acentos y emojis en cabeceras HTTP. El campo `click` lleva la URL del producto: al tocar la notificación se abre la tienda.
- **Respaldo: correo vía Gmail SMTP.** Con verificación en dos pasos y contraseña de aplicación. Servidor `smtp.gmail.com`, puerto 465 (SSL) o 587 (STARTTLS). Enviar versión HTML y texto plano.
- Los avisos de meta se envían por **ambos canales**, de forma independiente: si uno falla, el otro igual se envía, y cada intento se registra en `notifications`.

### 10.2 Tipos y plantillas (en español)

| Tipo | Prioridad | Contenido |
| --- | --- | --- |
| `goal_reached` | Alta | Título «🔥 {nombre}». Mensaje: «Ahora S/ 1,790 · tu meta S/ 1,800 · −22% vs referencia S/ 2,300». Enlace al producto. |
| `dropped_further` | Alta | «📉 {nombre} bajó aún más: S/ X (antes S/ Y)». |
| `extraction_failed` | Normal | «⚠️ No pude leer {nombre}. Revísalo en Scrappy.» |
| `suspicious_change` | Normal | «🤔 Precio raro en {nombre}: S/ X (antes S/ Y). Verificando.» |
| `system_down` | Alta | Lo emite el latido externo (10.3), por correo. |
| `test` | Normal | «✅ Notificación de prueba de Scrappy». |

### 10.3 Latido (detectar que el sistema murió)

Si GitHub Actions deja de ejecutar el cron, nadie avisaría. Por eso, al final de cada ejecución exitosa el scraper hace ping a **Healthchecks.io** (`HEALTHCHECK_URL`), configurado para enviar un correo al dueño si pasan más de unas 12 horas sin ping, y se hace ping a la URL de fallo si la ejecución termina con error. **Validar** el plan gratuito vigente. Revisar también el comportamiento de GitHub respecto a la desactivación de workflows programados por inactividad.

## 11. Interfaz web

**Estilo (Decidido): oscuro y minimalista, con cuidado en el detalle.**

- Solo tema oscuro en la v1. Fondo casi negro, superficies con bordes sutiles, un único color de acento (sugerido: verde esmeralda, asociado a «oferta»), tipografía Inter o Geist, números tabulares para precios, mucho espacio en blanco.
- Animaciones breves (200 ms o menos) con Motion; respetar `prefers-reduced-motion`.
- **Mobile-first**, responsive, instalable como PWA. Estados de carga con skeletons, estados vacíos con mensaje útil, errores comprensibles.

**Pantallas:**

1. **Acceso:** un campo para la clave.
2. **Inicio:** listas como pestañas o barra lateral. Tarjetas de producto con imagen, nombre, dominio, precio actual, meta, barra de progreso hacia la meta, variación contra la referencia, sparkline e insignias de estado (activo, pausado, error, meta alcanzada). Orden y filtro básicos.
3. **Añadir producto** (panel o modal): URL → progreso de lectura → tarjeta de confirmación (con candidatos o selector si falla) → lista, condición con equivalente en vivo, intervalo → guardar.
4. **Detalle de producto:** gráfico de líneas del historial (rangos 7 días, 30 días, 90 días y todo), con líneas horizontales de meta y referencia. Estadísticas: mínimo, máximo y promedio históricos, tendencia del descuento. Registro de las últimas revisiones. Acciones: editar, pausar, eliminar, **revisar ahora**, abrir tienda.
5. **Listas:** crear, renombrar, reordenar y eliminar.
6. **Ajustes:** botón **enviar notificación de prueba** (ambos canales), intervalo por defecto, estado de la última ejecución, historial de notificaciones.

## 12. Seguridad y secretos

- **Acceso con clave simple (Decidido).** Pantalla de acceso; la función `/api/login` compara la clave con `ACCESS_KEY` en tiempo constante y emite una cookie de sesión firmada con `SESSION_SECRET` (`httpOnly`, `secure`, `sameSite=strict`, validez de 30 días). Todas las demás rutas `/api` exigen esa sesión. Limitar intentos (por ejemplo 5 cada 15 minutos por IP) usando `login_attempts`.
- La `service_role key` de Supabase solo existe en el servidor (Vercel y GitHub Secrets), nunca en el bundle del cliente.
- **Variables en Vercel:** `ACCESS_KEY`, `SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_TOKEN` (token de grano fino con permiso solo de Actions sobre este repositorio), `GITHUB_REPO`.
- **GitHub Secrets:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NTFY_TOPIC`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `NOTIFY_EMAIL_TO`, `HEALTHCHECK_URL`.
- Nunca commitear secretos. Incluir `.env.example` con todos los nombres y sin valores.

## 13. Estructura del repositorio y workflow

```
scrappy/
├─ src/                     # app React (Vite)
├─ api/                     # Vercel Functions (TypeScript)
├─ public/
├─ scraper/                 # paquete Python `scrappy` (pyproject, tests, fixtures)
├─ supabase/migrations/
├─ .github/workflows/check-prices.yml
├─ docs/decisions.md
└─ .env.example
```

**Workflow `check-prices.yml`:**

- Disparadores: `schedule` con cron `0 */3 * * *` y `workflow_dispatch` con entradas `mode` (`all`, `product` o `test_notification`) y `product_id` opcional.
- `concurrency` con un solo grupo y `cancel-in-progress: false`, para que las ejecuciones se encolen sin pisarse.
- Pasos: checkout, Python con caché de pip, instalación de dependencias, caché de los navegadores de Playwright (instalar con `scrapling install` solo si falta), ejecutar `python -m scrappy.run --mode ...`, ping de latido (y a la URL de fallo si hay error). `timeout-minutes: 20`.
- **Presupuesto:** un repositorio privado dispone de un número limitado de minutos gratuitos al mes (verificar la cifra vigente). Con 8 ejecuciones al día, mantener cada ejecución corta y **medir y reportar** el consumo real.

## 14. Fases y criterios de aceptación

**Fase 0: Cimientos.** Repositorio, proyecto Supabase con migraciones, secretos, esqueleto del workflow y del paquete Python. *Aceptación:* el workflow corre vacío, conecta con Supabase y hace ping al latido.

**Fase 1: Validación del extractor (puerta de decisión).** CLI `python -m scrappy.probe urls.txt` que, para cada URL, indica estrategia usada, nombre, precio, moneda, confianza y modo de obtención necesario. Probar con **al menos 15 URLs de tiendas variadas** (grandes, locales y pequeñas; el dueño aportará la lista o el agente propondrá una muestra), tanto desde la máquina local como desde GitHub Actions. *Aceptación:* informe con tasa de éxito por estrategia, tiendas que requieren navegador o modo stealth, tiendas que fallan y diferencias entre IP local e IP de Actions. Meta orientativa: 70% o más de las URLs leídas correctamente sin intervención manual. Si es menor, reportar y proponer ajustes **antes de continuar**. Evaluar también cómo persistir el modo adaptativo de Scrapling entre ejecuciones efímeras; si no es viable, usar selectores CSS por dominio.

**Fase 2: Motor.** Persistencia, selección de productos vencidos, validaciones, máquina de estados, ntfy y correo, registro de ejecuciones, modo `workflow_dispatch`. *Aceptación:* con productos de prueba, se cumple la condición y llegan las notificaciones por ambos canales una sola vez; se simulan fallos y precios sospechosos con fixtures.

**Fase 3: Web.** Acceso, listas, flujo de añadir con confirmación, detalle con gráficos, ajustes con notificación de prueba y «revisar ahora». *Aceptación:* flujo completo funcionando desde el celular instalado como PWA.

**Fase 4: Resiliencia y documentación.** Alertas de fallo, latido verificado (apagar el cron y confirmar que llega el aviso), README con la guía paso a paso de configuración (Supabase, Vercel, GitHub Secrets, app ntfy en el celular, contraseña de aplicación de Gmail) y documentación del plan B local. *Aceptación:* un tercero puede desplegar el proyecto siguiendo solo el README.

## 15. Pruebas

- Pruebas unitarias del parser de precios (formatos y monedas), de cada estrategia de extracción con **fixtures de HTML guardado**, de la máquina de estados y de las validaciones.
- Prueba de integración contra un proyecto Supabase de pruebas.
- Lista de verificación manual: llegada real de push al celular (incluyendo con la app cerrada), correo, enlace de la notificación, flujo de la UI en móvil.

## 16. Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| Bloqueo anti-bot (en especial grandes tiendas) | Escalado de obtención por capas, frecuencia baja, plan B local con IP residencial, y aviso visible cuando una tienda no se puede leer. |
| IPs de GitHub Actions bloqueadas | Paquete ejecutable por CLI en la PC o Raspberry del dueño. |
| Cambios de HTML en las tiendas | Datos estructurados primero, recetas por dominio, modo adaptativo, alerta de fallo. |
| Precios ambiguos (cuotas, variantes, envío) | Heurística con exclusiones, confirmación al registrar, validación de variaciones bruscas. |
| Sistema detenido sin que el dueño lo note | Latido externo con aviso por correo. |
| Cambios en los planes gratuitos | Verificar al implementar; dependencias intercambiables (Supabase, Vercel y ntfy tienen alternativas). |
| Términos de servicio de las tiendas | Bajo volumen y uso personal; riesgo asumido por el dueño. |

## 17. Backlog (fuera de la v1)

Búsqueda por nombre de producto, resumen diario o semanal, aviso de nuevo mínimo histórico, importar y exportar, canal Telegram, modo claro, comparación del mismo producto entre tiendas, notificación programada en horario silencioso.
