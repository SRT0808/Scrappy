# Estado actual de Scrappy

## Hito vigente (2026-11-08)
- **Promoción a main autorizada por el dueño (2026-11-08, SPEC §11/14):** `main` avanza por fast-forward de `3bb4858` al candidato `fcd861f` más este registro, tras la revisión local del dueño. Incluye la revisión del sistema de diseño y los arreglos UX-1 a UX-4. Sin cambios de API, BD ni workflows.
- **Revisión del sistema de diseño (SPEC §11, `docs/decisions.md` 2026-11-08):**
  - Tokens neutros con marca monocroma y cuatro señales (verde, ámbar, rojo y azul) en `src/index.css`; Geist y Geist Mono en lugar de Inter; iconos `lucide-react`.
  - Primitivas de presentación en `src/components/ui/` (Select, Badge, Notice, Skeleton, EmptyState, Logo y variantes de botón).
  - Catálogo en filas densas con filtros rápidos por señal y distancia a la meta; gráficos con zona de meta y colores por token; esqueletos y avisos unificados en todas las pantallas.
  - Validación: typecheck y build aprobados. Las pruebas web afectadas pasan; persisten 6 fallos previos e independientes en `App`, `AddProduct` y `PwaControls` (idénticos sin estos cambios).
- **UX-3 y UX-4 corregidos e integrados:**
  - `637d375 feat: sync navigation with browser history and flag stale readings`
  - `033ab6d test: reset the URL between web tests`
- **UX-1 y UX-2 corregidos e integrados:**
  - `46f1982 fix: keep Enter in compare dialog from submitting the purchase form`
  - `d7d4600 fix: show logout errors without hiding the product catalog`
- **Auditoría de documentación y adopción DevFlow:** Reglas de `AGENTS.md` alineadas con la orquestación DevFlow. Historial extenso archivado en `docs/STATUS-history.md`.

## Siguiente paso
- Verificar el despliegue de Vercel para el nuevo SHA de `main` (antes, la Ignored Build Step canceló despliegues automáticos).
- Regenerar los iconos PNG de la PWA (`pwa-*.png`, `apple-touch-icon.png`) con la nueva marca.
- Pendiente de la auditoría UI/UX: UX-5 (foco en diálogos de confirmación) y UX-6 (foco y estabilidad en rangos). UX-7 y UX-8 quedan cubiertos por la revisión del diseño.
- Corregir los 6 fallos previos de pruebas web en `App`, `AddProduct` y `PwaControls`.

---
> Para consultar el registro detallado de fases anteriores (2026-10-13 a 2026-10-28), ver `docs/STATUS-history.md`.
