# Scrappy: instrucciones para el agente

Proyecto personal, un solo usuario, 100% gratuito. Especificación completa en docs/SPEC.md (no la leas entera: lee solo las secciones que pida la tarea). Estado actual en docs/STATUS.md (léelo al empezar cada hilo).

## Operación automática verificada (2026-10-13)

La misión de SPEC §14.1 está cerrada: tres slots rápidos y tres normales conciliados, caída real por ausencia de latido recibida en Gmail y recuperación automática verificada. Evidencia y límites en README y docs/STATUS.md; auditoría privada `.scrappy/mission-final-audit.json`.
La excepción temporal de persistencia quedó retirada. Vuelven las reglas generales de este archivo; no reactivar ensayos ni seguimientos antiguos. Operación habitual: cron-job.org → Actions cada 3h y Healthchecks periodo 3h/gracia 9h, independiente de Windows/Codex. Main y nuevas promociones siguen siendo decisión del dueño.

## Stack (decidido, no cambiar sin avisar)
Web: React + Vite + TypeScript + Tailwind + shadcn/ui + Recharts, tema oscuro minimalista. API: Vercel Functions (TypeScript, carpeta api/). Datos: Supabase Postgres (el navegador nunca habla con Supabase). Scraper: Python 3.11+ con Scrapling (version fijada) en scraper/. Cron: GitHub Actions. Avisos: ntfy (principal) y Gmail SMTP (respaldo).

## Convenciones
- Codigo, commits y comentarios en ingles; interfaz y avisos al usuario en espanol.
- Commits pequenos, uno por tarea, mensaje convencional (feat:, fix:, chore:). Trabaja siempre en la rama develop. Nunca hagas commit ni merge a main: eso lo decide el usuario.
- El cron de GitHub Actions y el despliegue de produccion corren desde main. Avisame cuando una fase este lista para pasar a main.
- Nunca commitear secretos. Los valores reales van en .env (ignorado por git). Mantén .env.example al dia.
- No agregues servicios de pago ni dependencias que no hagan falta.
- Avisame cuando necesites una cuenta o un secreto; no los pidas por adelantado.
- Entorno del usuario: Windows 11, PowerShell.
- Vercel se deja para el final de la Fase 3. Hasta entonces, todo se desarrolla y prueba en local (web y API con un solo comando, sin cuenta de Vercel). Mantén los handlers de api/ en formato compatible con Vercel para que desplegar sea trivial, pero no configures ni pruebes Vercel salvo que yo lo pida.
- Mantén separadas las fases de desarrollo y despliegue. Durante el desarrollo, prioriza extracción, analíticas, autenticación, flujos y experiencia de usuario; ejecuta las validaciones en el Windows del usuario, en localhost y con fixtures locales cuando corresponda. No pidas al usuario probar desde su teléfono, otro dispositivo o servicios desplegados, ni configurar certificados, cuentas o conectividad remota solo para aceptar desarrollo local. La verificación real de instalación PWA en dispositivos, HTTPS público, Vercel, Actions en producción e integraciones desplegadas queda para la fase de despliegue. Conserva compatibilidad de código con esos contratos sin adelantar sus pruebas ni bloquear el desarrollo. Las pruebas móviles de desarrollo se hacen con emulación local; el scraping de sitios desde Windows sigue siendo parte del desarrollo cuando la tarea lo requiera.

## Principio de proporcionalidad
Haz lo minimo necesario para un resultado correcto y verificado.
- Tarea de 1 a 2 archivos: sin plan escrito. Tarea mayor: plan de maximo 10 lineas.
- No leas todo el repo: busca lo relevante.
- Validacion segun riesgo: cambio local, una comprobacion dirigida; logica con riesgo (alertas, parser, auth), tests unitarios mas un caso limite; fase cerrada, /review. Ejecuta solo las pruebas afectadas y no repitas las que ya pasaron.
- No crees documentacion nueva salvo README y una linea en docs/decisions.md para decisiones no obvias.
- No uses capturas, navegador ni computer use salvo un fallo de interfaz que no puedas razonar con codigo, tests o logs. En la fase web, una verificacion visual por pantalla al terminar.
- No uses subagentes, modo Fast, Max ni Ultra salvo que el usuario lo pida.
- Informe final de 10 lineas como maximo: que cambio, como se valido, que falta.

## Fin de cada tarea (obligatorio)
1. Actualiza docs/STATUS.md (2 o 3 lineas: hecho y siguiente).
2. Clasifica la SIGUIENTE tarea con este arbol, en orden:
   P1 Trivial (un archivo, causa clara, sin logica nueva): verde, y no recomiendes cambiar de modelo.
   P2 Seguridad (auth, sesion, secretos, RLS), migracion que altera datos o logica con estado/orden (alertas, reintentos, deduplicacion, polling): minimo amarillo.
   P3 Cambia un contrato compartido (esquema BD, formato scraper-API, variables, workflow) o toca 3+ archivos en 2+ capas: minimo amarillo. No cuenta si ya existe un patron identico en el repo y la spec fija el resultado.
   P4 Incertidumbre real (causa desconocida, requisito ambiguo, diseno abierto, codigo sin leer): si ya es amarillo pasa a naranja; si no, amarillo.
   P5 Dos intentos fallidos del modelo actual en esta tarea: sube un nivel. Rojo solo si fallo en naranja y requiere aprobacion del usuario.
   Ninguna aplica: verde.
3. Modelos: 🟢 verde = GPT-6 Luna High; 🟡 amarillo = GPT-6.1 Sol Medium; 🟠 naranja = GPT-6.1 Sol High; 🔴 rojo = GPT-6 Astra Light.
4. Anti-vaiven: sube siempre que el nivel lo exija. Baja solo al empezar un lote de 2+ tareas verdes o una tarea verde larga y repetitiva. Cambiar de modelo implica hilo nuevo; cambiar solo el esfuerzo del mismo modelo no. Agrupa tareas sin dependencias por nivel.
5. Termina con este bloque exacto:
6. HILO: MISMO solo si la siguiente accion corrige la tarea que acabas de hacer. Toda tarea nueva es NUEVO y debe incluir la linea para pegar.

━━ SIGUIENTE PASO ━━
Tarea: <una linea>
Nivel: <emoji> · Motivo: <max. 15 palabras>
MODELO: <modelo · esfuerzo>
CAMBIAR: <SÍ / NO / compara con tu selector> · HILO: <NUEVO / MISMO>
Validacion: <minima necesaria, una linea>
Pega en el hilo nuevo: «Lee AGENTS.md y docs/STATUS.md. Tarea: ... (SPEC §N). Hecho cuando: ...»

(Si HILO es MISMO, omite la ultima linea. Si no sabes con certeza que modelo usa el usuario, escribe «compara con tu selector».)

## Si algo falla
Tras 2 intentos fallidos en la misma tarea, detente: resume en 5 lineas que probaste y la evidencia (test, logs) y emite el bloque recomendando subir de nivel en hilo nuevo. En fallos de scraping por bloqueo o HTML inesperado, recopila evidencia antes de razonar mas. Si una tarea resulta mas compleja de lo clasificado, detente y dilo antes de seguir.
