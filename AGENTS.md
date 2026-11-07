# Scrappy: instrucciones para agentes

Proyecto personal, un solo usuario, 100% gratuito. Especificación en `docs/SPEC.md`. Estado vigente en `docs/STATUS.md` (historial detallado en `docs/STATUS-history.md`).

## Stack (decidido, no cambiar sin avisar)
- **Web:** React + Vite + TypeScript + Tailwind + shadcn/ui + Recharts, tema oscuro minimalista.
- **API:** Vercel Functions (TypeScript, carpeta `api/`).
- **Datos:** Supabase Postgres (el navegador nunca habla directamente con Supabase).
- **Scraper:** Python 3.11+ con Scrapling (versión fijada) en `scraper/`.
- **Scheduler:** cron-job.org → GitHub Actions (`workflow_dispatch` en `main`).
- **Avisos:** ntfy (principal) y Gmail SMTP (respaldo).

## Convenciones e Invariantes del Proyecto
- **Idioma:** Código, commits y comentarios en inglés; interfaz y avisos al usuario en español.
- **Git y Ramas:** Commits pequeños y convencionales (`feat:`, `fix:`, `chore:`). Trabaja siempre en la rama `develop`. Nunca hagas commit directo ni merge a `main`: la promoción y el despliegue a producción son decisión exclusiva del dueño.
- **Producción:** El cron de GitHub Actions y el despliegue de Vercel corren desde `main`. Avisa al dueño cuando un paquete o fase esté lista para pasar a `main`.
- **Secretos:** Nunca commitear secretos. Los valores reales van en `.env` (ignorado por git). Mantén `.env.example` al día.
- **Coste cero:** No agregues servicios de pago ni dependencias superfluas.
- **Entorno:** Windows 11, PowerShell.
- **Desarrollo local primero:** Mantén separadas las fases de desarrollo y despliegue. Durante el desarrollo, prioriza lógica, contratos, validaciones y UX en localhost (y fixtures cuando aplique). Las comprobaciones reales de producción o en dispositivos móviles externos quedan para la fase de despliegue autorizada por el dueño.

## Flujo de Trabajo con DevFlow
- **Orquestación y Modelos:** La asignación de roles (`orchestrator`, `planner`, `auditor`, `worker`), la complejidad (`T1` a `T4`) y la política de modelos son gestionadas automáticamente por DevFlow.
- **Comunicación IPC:** La coordinación entre agentes se realiza mediante Herdr (`hc send`, `hc get`, `hc wait`).
- **Paquetes y Trabajo Aislado:** Los workers implementan cambios dentro de sus worktrees efímeros asignados mediante `devflow delegate`. La validación e integración se realiza con `devflow validate` y `devflow integrate`.
- **Auditoría y Hallazgos:** El auditor opera en modo de solo lectura, ejecuta verificaciones no destructivas y registra hallazgos estructurados mediante `devflow record`.
- **Actualización de Estado:** El orquestador consolida los hitos aprobados en `docs/STATUS.md` y archiva decisiones no obvias en `docs/decisions.md`.
