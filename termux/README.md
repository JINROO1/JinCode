# JinCode en Termux (Android)

JinCode es un **fork de DeepSeek Harness** (`deepseek-ai/deepseek-harness`, MIT) con la misma
arquitectura y funcionalidad (agente, herramientas, sandbox, sesiones, web UI), adaptado para
ejecutarse **en Termux sobre Android** con una **interfaz web mobile-first**.

- **Motor:** el código del harness se reutiliza tal cual; el fork aporta una capa de adaptación
  (patch de perfil) y una interfaz de usuario móvil nueva.
- **Modelo:** cualquier endpoint **OpenAI-compatible** (OpenAI, DeepSeek, OpenRouter, vLLM,
  Gateway propio…), vía el adaptador `llm-pi-ai` del harness.
- **UI:** React + TypeScript + Vite + Tailwind CSS + Zustand, con un *shell* de pestañas
  móvil que adapta los slot del desktop (sidebar / main / rightbar) a una navegación por
  pestañas, sin texturas recortadas ni botones que cubran la interfaz.

## Estructura

```
termux/
├── setup.sh                     # instalación completa (toolchain, fuente, build, perfil)
├── check.sh                     # preflight: verifica el estado antes de arrancar (--deep compone el perfil)
├── start.sh                     # arranca el servidor web
├── profile.cordis.patch.yml     # capa de adaptación del perfil `jincode` (sandbox + modelo)
├── profile.package.json         # manifiesto del perfil (bundles: dsh-base + dsh-web-app)
├── patches/jincode-harness.patch  # diff del fork aplicado al fuente de deepseek-harness
└── HARNESS_COMMIT               # commit de deepseek-harness sobre el que aplica el patch
```

## Prerrequisitos

- **Termux** en un teléfono Android.
- Conexión a internet para clonar fuentes e instalar dependencias.
- **Node.js ≥ 22** (24.9+ recomendado; Termux: `pkg install nodejs`). El harness exige
  `engines.node >= 24.9.0`; con versiones anteriores el build y el servidor funcionan con una
  advertencia `Unsupported engine`.
- **RAM:** el build es pesado. Si el teléfono tiene poca memoria, añade swap (root o
  `su`):

  ```bash
  dd if=/dev/zero of=$HOME/swapfile bs=1M count=4096
  chmod 600 $HOME/swapfile
  mkswap $HOME/swapfile
  swapon $HOME/swapfile
  ```

## Instalación

```bash
git clone https://github.com/JINROO1/JinCode.git ~/jincode
cd ~/jincode
bash termux/setup.sh
```

`setup.sh`:

1. instala Node.js y git (vía `pkg`) y activa pnpm (corepack);
2. clona `deepseek-ai/deepseek-harness` en `harness/` en el commit fijado de
   `HARNESS_COMMIT` y aplica `patches/jincode-harness.patch` (la UI móvil del fork);
3. instala dependencias (`pnpm install`) y compila todo (`pnpm run build`, host + cliente web);
4. instala el perfil `jincode` en `~/.dsh/profiles/jincode`.

## Configuración del modelo

Crea el archivo de entorno con los datos de tu endpoint OpenAI-compatible:

```bash
mkdir -p ~/.jincode
cat > ~/.jincode/env <<'ENV'
JINCODE_API_KEY=sk-...
JINCODE_BASE_URL=https://api.openai.com/v1
JINCODE_MODEL=gpt-4o-mini
ENV
```

| Variable | Default | Significado |
|---|---|---|
| `JINCODE_API_KEY` | — (obligatoria) | Clave de API; se resuelve por petición vía la costura de credenciales (ambiente, `.env`, o `~/.dsh/.credentials.yaml`) |
| `JINCODE_BASE_URL` | `https://api.openai.com/v1` | Base del endpoint (`/v1` incluida) |
| `JINCODE_MODEL` | `gpt-4o-mini` | Identificador del modelo servido por el endpoint |
| `JINCODE_CONTEXT_WINDOW` | `128000` | Ventana de contexto por defecto de la ruta |
| `JINCODE_MAX_TOKENS` | `32768` | Cap de salida por defecto de la ruta |
| `JINCODE_BASH_TIMEOUT_MS` | `120000` | Timeout por comando del executor bash |

La ruta se declara en la capa de perfil (`profile.cordis.patch.yml`) como proveedor
manual `jincode` con `api: openai-completions`, y `agent-default-model` apunta a ella. Para
endpoints con formato de razonamiento DeepSeek-style (`reasoning_content`) añade a la ruta:

```yaml
compat:
  thinkingFormat: deepseek
```

## Ejecución

Antes de arrancar, verifica que la instalación está completa (toolchain, patch del fork,
build, perfil y clave de API; con `--deep` también compone el perfil y comprueba que no hay
warnings):

```bash
bash termux/check.sh          # checks rápidos
bash termux/check.sh --deep   # también compone el perfil jincode
```

Luego:

```bash
bash termux/start.sh
```

- atanca en `0.0.0.0:3080` (cambiable con `HOST`/`PORT`).
- **Primera visita:** el servidor imprime una URL con `?token=...`. Abre
  `http://127.0.0.1:3080` en el navegador del teléfono y, si se muestra el token, añádelo a
  la URL una vez para autorizar la sesión (después, la cookie deja pasar las peticiones).
- Desde otro dispositivo de la misma red: `http://<ip-del-telefono>:3080`.
- **Telemetría:** `start.sh` sets `DSH_TELEMETRY_DISABLED=1`; la telemetría OTel del harness
  queda apagada.

## La adaptación Termux (profile.cordis.patch.yml)

En Android no existen Docker, bwrap ni el launcher Landlock nativo, así que el sandbox
confinante `dsh-sandbox-local` **fallaría en cierre** (`SANDBOX_UNAVAILABLE`) al primer
comando. La capa de perfil resuelve esto de forma explícita:

- **`sandbox-policy` → `danger-full-access`** (o `DSH_PERMISSION_MODE` si lo defines): cada
  consumidor que confina (`bash-sandbox`, `terminal-bash`, worker `ptc-runtime`,
  `fs-sandbox`) cortocircuita o nunca llama a `ctx.sandbox.confine` bajo este modo, así que
  la costura nunca se ejerce.
- **`approval` → `never`** bajo `danger-full-access` (la misma regla que el bundle base).
- **`bash-sandbox` desactivado** y **`bash-local` (`@deepseek-ai/dsh-bash-local`) insertionado**:
  cada comando corre como un `bash -c` fresco, sin confinamiento, con la autoridad del
  proceso del harness. *(Un patch no puede renombrar una fila, por lo que el executor
  confinante se desactiva y se inserta uno nuevo con id distinto.)*
- **Mejora del motor (parte del patch):** `bash-local` ahora inyecta `sandboxPolicy` y expone
  `sandboxMode` (el modo de política que ejecuta). Sin esto, el plugin
  `permission-presets` rechazaba activarse sobre un executor sin confinar
  (`the mounted bash executor does not confine`); con ello la composición completa
  (incluido el selector de permisos por sesión) se activa sin warnings.
- **Ruta de modelo** `jincode` sobre el adaptador `llm-pi-ai` (dormiente por defecto en el
  bundle base), y `agent-default-model` redirigido a ella.

> **Seguridad:** `danger-full-access` significa que los comandos del agente corren con la
> autoridad completa de la app Termux (incluidas las opciones de storage compartido si las
> habilitas). Es el modelo de confianza de un entorno sin sandbox kernel; revoca el API key
> si sospechas uso no deseado.

## Interfaz móvil

- Detecta `(max-width: 820px)` y muestra el *shell* de pestañas (conversations / chat /
  files) en lugar del layout de tres columnas.
- Usa `100dvh` (con respaldo `100vh − inset del teclado` via `visualViewport`), insets de
  *safe-area* (`env(safe-area-inset-*)`) y targets de navegación ≥ 48 px, por lo que los
  botones del sistema (navegación, teclado) **no cubren** la interfaz.
- Texto en descripciones y botones se dimensiona con `overflow-wrap: anywhere` y flex panes
  con `min-height/min-width: 0`, sin recorte ni solapamiento.

## Notas y solución de problemas

- **`Unsupported engine`:** Node < 24.9. Funciona con advertencia; para eliminarla,
  actualiza Node (24.9+).
- **Build lento / agotamiento de memoria:** añade swap (ver arriba) y revisa que el build
  no se haya interrumpido; `setup.sh --skip-build` reutiliza el `dist` anterior.
- **`MISSING_CREDENTIAL`:** `JINCODE_API_KEY` no está definido o está vacío; revisa
  `~/.jincode/env`.
- **`web_search` no funciona:** el proveedor de búsqueda del bundle base es el de DeepSeek y
  necesita `DEEPSEEK_API_KEY`. El resto de las herramientas (`bash`, `fs`, `edit`,
  subagentes,…) no dependen de ello. `web_fetch` funciona sin clave (solo destinos HTTP(S)
  públicos).
- **Actualizar el fork:** el patch sigue al commit fijado en `HARNESS_COMMIT`. Para adoptar
  un master nuevo de deepseek-harness, vuelve a clonar el harness, regenera el patch y
  re-ejecuta `setup.sh`.

## Licencia

DeepSeek Harness es MIT; este fork mantiene la misma licencia para el código derivado.
