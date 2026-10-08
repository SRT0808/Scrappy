# STATUS
Fase: 0 (migración aplicada en Supabase; aceptación del workflow pendiente).
Hecho: ocho tablas creadas y verificadas con RLS, cero políticas públicas, sin permisos anon/authenticated y acceso service_role; caso límite de contadores inconsistentes rechazado. Tres Secrets de Actions configurados desde .env; siete tests unitarios previamente aprobados. Clientes de administración instalados solo en .venv; AGENTS.md conserva el cambio previo del usuario.
Siguiente: publicar y ejecutar el workflow en develop, confirmar registro de run vacío y ping, medir duración y cerrar revisión de fase (SPEC §7, §12–14). Omitir actionlint por instrucción del usuario; validar con Actions. Después: CLI probe y validación del extractor (SPEC §14, fase 1).
