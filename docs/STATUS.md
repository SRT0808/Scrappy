# Estado actual de Scrappy

## Hito vigente (2026-11-06)
- **Auditoría de documentación y adopción DevFlow:** Reglas de `AGENTS.md` alineadas con la orquestación DevFlow (T1-T4, roles nativos, escalado automático). Invariantes de ingeniería preservadas. Historial extenso archivado en `docs/STATUS-history.md`.
- **Auditoría UI/UX web:** Claude Opus 5.5 (high effort) identificó 8 hallazgos importantes y 15 menores (registrados en `state.json` de DevFlow). 0 críticos. Pruebas dinámicas en vitest confirmaron UX-1 y UX-2.
- **Producción:** `main` en `3bb4858` (YesStyle desplegado y verificado, Vercel `dpl_Ao1S6JVbe7bQYogyNaXTQUFi4Dj9` READY, Actions y Healthchecks 3h/9h activos).

## Siguiente paso
- Corregir UX-1 (aislar diálogo Comparar producto del formulario del editor en `PurchaseBasketScreen` / `PurchaseOptionBuilder`) y UX-2 (separar alerta de `sessionError` de la cuadrícula en `HomeScreen`).

---
> Para consultar el registro detallado de fases anteriores (2026-10-13 a 2026-10-28), ver `docs/STATUS-history.md`.
