# JinCode

Fork de **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (MIT) con la
misma arquitectura y funcionalidad —agente, herramientas, sandbox, sesiones, web UI— adaptado
para **ejecutarse en Termux sobre Android** con una **interfaz web mobile-first** y un modelo
configurable de **cualquier endpoint OpenAI-compatible**.

## Qué contiene este repositorio

- `termux/` — la adaptación para Android/Termux:
  - `setup.sh` / `check.sh` / `start.sh` — instalación, preflight de diagnóstico y arranque;
  - `profile.cordis.patch.yml` — capa de perfil `jincode`: sandbox sin confinamiento
    (`danger-full-access` + `bash-local`, ya que Docker/bwrap/Landlock no existen en Android)
    y ruta de modelo OpenAI-compatible vía `llm-pi-ai`;
  - `patches/jincode-harness.patch` — diff del fork aplicado al fuente de
    deepseek-harness: **UI móvil** (`MobileFrame`, `RootFrame`, locales `layout.shell`), la
    corrección del lector `.xls`, y una **mejora del motor**: `bash-local` reporta
    `sandboxMode` para que `permission-presets` se active sobre el executor sin confinar;
  - `HARNESS_COMMIT` — commit de deepseek-harness sobre el que aplica el patch.
- El fuente del harness (deepseek-harness master en `HARNESS_COMMIT` + patch) se prepara
  durante `setup.sh` en `harness/`; no se versiona en este repositorio para mantener el fork
  ligero.

## Inicio rápido (Termux)

```bash
git clone https://github.com/JINROO1/JinCode.git ~/jincode
cd ~/jincode
bash termux/setup.sh        # Node/pnpm, clone + patch del harness, build, perfil jincode
cat > ~/.jincode/env <<'ENV'
JINCODE_API_KEY=sk-...
JINCODE_BASE_URL=https://api.openai.com/v1
JINCODE_MODEL=gpt-4o-mini
ENV
bash termux/start.sh        # http://127.0.0.1:3080
```

Ver `termux/README.md` para la configuración completa, la arquitectura de la adaptación y la
solución de problemas.

## Licencia

MIT (heredada de DeepSeek Harness).
