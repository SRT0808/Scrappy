# Estado actual de Scrappy

## Hito vigente (2026-11-07)
- **UX-3 y UX-4 corregidos e integrados:**
  - `b397134 feat: sync navigation with browser history and flag stale readings`
  - `fd6ed63 test: reset the URL between web tests`
  - Sincronización de navegación con History API (`pushState`/`popstate`), badges de precio desactualizado / revisión pendiente, y filtro `stale`.
- **UX-1 y UX-2 corregidos e integrados:**
  - `b101868 fix: keep Enter in compare dialog from submitting the purchase form`
  - `0568b7b fix: show logout errors without hiding the product catalog`
- **Auditoría de documentación y adopción DevFlow:** Reglas de `AGENTS.md` alineadas con la orquestación DevFlow. Historial extenso archivado en `docs/STATUS-history.md`.
- **Producción:** `main` en `3bb4858` (YesStyle desplegado y verificado, Vercel `dpl_Ao1S6JVbe7bQYogyNaXTQUFi4Dj9` READY, Actions y Healthchecks 3h/9h activos).

## Siguiente paso
- Evaluar e implementar siguientes hallazgos de auditoría UI/UX (UX-5: posición y foco en diálogos de confirmación; UX-6: foco y estabilidad en paginación/rangos; UX-7: contraste en bordes de inputs; UX-8: densidad móvil).

---
> Para consultar el registro detallado de fases anteriores (2026-10-13 a 2026-10-28), ver `docs/STATUS-history.md`.
