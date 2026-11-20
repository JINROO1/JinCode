# jincode-cli

Cliente de terminal de JinCode. Sustituye la interfaz web del harness: habla con el servidor
DeepSeek Harness (perfil `jincode`) a través de su **API remota** (HTTP RPC + WebSocket
multiplexado), y dibuja una interfaz de pantalla completa con Ink (React para terminal).

## Uso

En Termux, con el servidor en marcha (`bash termux/start.sh`):

```bash
bash termux/jincode.sh "http://127.0.0.1:3080/?token=..."
# o, con la variable de entorno:
JINCODE_URL="http://127.0.0.1:3080/?token=..." bash termux/jincode.sh
```

La URL es la que imprime el servidor al arrancar. Contiene el token de acceso: el cliente lo
intercambia por una cookie de sesión y no lo guarda en disco.

## Teclas

| Tecla | Acción |
|---|---|
| Enter | Enviar. Si hay un turno en curso, el texto **dirige** ese turno (`steer`) |
| Alt+Enter · Ctrl+J | Nueva línea en el mensaje |
| Ctrl+N | Nueva sesión |
| Ctrl+K | Lista de sesiones (Enter abre) |
| Ctrl+O | Elegir modelo y esfuerzo de razonamiento (Tab cambia el esfuerzo, Enter confirma) |
| Ctrl+T | Panel: cola, permisos, ajustes, espacios, archivos, terminal, metas, programaciones y habilidades (ver abajo) |
| Ctrl+G | Claves de los proveedores: Tab cambia de proveedor, Enter guarda, Ctrl+D elimina |
| Ctrl+F | Buscar en las sesiones (títulos y carpetas; contenido si el Host lo tiene activo) |
| Ctrl+U | Adjuntar un archivo o una imagen (ruta; las imágenes se envían como imagen, el resto se sube) |
| Ctrl+R | Renombrar la sesión |
| Ctrl+B | Bifurcar la sesión |
| Esc · Ctrl+C | Cancelar el turno en curso (Esc también cierra cualquier superposición) |
| PgUp · PgDn | Desplazar la conversación |
| Ctrl+P · ? | Ayuda con todas las teclas (`?` solo con el mensaje vacío) |
| Ctrl+Q | Salir. La sesión sigue en el Host |

Teclas del panel (Ctrl+T; Tab y Shift+Tab cambian de sección, Ctrl+T o Esc lo cierran):

| Sección | Teclas |
|---|---|
| Cola | ↑↓ eligen un mensaje · `s` lo dirige al turno en curso · `e` lo edita (Enter guarda, Esc cancela) · `x` lo quita |
| Permisos | Enter aplica el preset. `danger-full-access` pide un segundo Enter porque no tiene confinamiento; Esc cancela |
| Ajustes | ↑↓ eligen un campo (agrupado por espacio de nombres). Enter edita el valor; Enter guarda, Esc cancela. `u` quita el valor propio (✎). `j` edita la sección entera en JSON (no disponible si tiene secretos). Con el perfil de solo lectura no se escribe nada |
| Metas | Sin meta: escribe el objetivo y Enter la crea. Con meta: `e` edita el objetivo (Enter guarda, Esc cancela; sin cambios no se envía nada); `p` pausa, `r` reanuda, `c` completa, `x` elimina (con el campo vacío). Si otro cliente cambió la meta, la CLI lo avisa y la vuelve a leer |
| Programaciones | ↑↓ listan todas las tareas, con su estado (activa, pausada, terminada, ejecutando) y su temporización. `n` crea; Enter o `e` edita; con el formulario abierto, ↑↓ cambian de campo, Enter guarda y Esc cancela. Temporizaciones: `after 600`, `every 3600`, `at 2026-12-01 09:30 Europe/Madrid`, `daily 09:00 UTC`, `weekly 09:00 UTC 1,3,5`, `cron 0 9 * * 1 UTC`, `rrule DTSTART:…\|RRULE:…`. Destinos: «sesión actual», «nueva sesión», «nueva sesión una vez». `p` pausa o reanuda; `r` ejecuta ahora; `h` lee las entregas; `x` elimina (dos veces); `c` quita las terminadas (dos veces). Una tarea terminada no se pausa |
| Agentes | Lista los presets del Host, con el predeterminado marcado. Enter selecciona el preset en la sesión activa (`agentPresets/select`), solo si no tiene turnos: el Host lo rechaza si ya empezó. `n` abre una sesión nueva con ese preset (`session/create`). `v` muestra u oculta su declaración en YAML (`agentPresets/read`, solo lectura) |
| Subagentes | Las sesiones hijas de la sesión activa, con «en curso» o «inactivo». Enter abre el subagente; con texto escrito, Enter lo envía (`subagents/prompt`, entrega en cola, o dirigida con Ctrl+D). Ctrl+X lo interrumpe (`subagents/interruptByUser`). Solo texto: las imágenes no se envían desde esta sección |
| Plugins | Lista los bundles del perfil (primero) y los plugins del cargador, con su estado y el motivo cuando son de solo lectura (`pluginManager/listBundles`, `listPlugins`). Con el campo vacío, Enter activa o desactiva la fila (`setBundleEnabled`, `setPluginEnabled`); las filas de solo lectura no se envían. Escribe un paquete (nombre, `nombre@versión`, ruta o dirección git) y Enter lo inspecciona (`pluginManager/inspect`); si el Host lo acepta, otro Enter con el mismo texto lo instala (`installBundle`, con identidad de petición). Ctrl+X quita un bundle que el perfil permite quitar, tras pulsarlo dos veces (`removeBundle`) |
| MCP | Los servidores MCP del Host con su estado en vivo (stream `mcpManager/watch`): conectado con sus herramientas, reconectando (intento de máximo), error con su motivo, o autorización pendiente. `p` sondea el servidor bajo el cursor (`mcpManager/probe`: negocia, lista sus herramientas y cierra, sin tocar la instancia viva) y deja el resultado bajo la lista; `r` lo reconstruye desde su entrada (`mcpManager/restart`, sin confirmación porque no borra nada). Los servidores se añaden y cambian en Ajustes, en la sección `mcp-manager` (`servers`) |
| Espacios | Lista en vivo (stream `workspace/follow`): cada espacio con sus sesiones, después «Sin espacio» y «Archivadas». `n` crea un espacio con la ruta escrita (vacío = espacio predeterminado). En un espacio: `r` renombra, `x` lo quita (dos veces; sus archivos y sesiones se conservan), `[` `]` lo suben o bajan. En una sesión: `p` fija o desfija, `a` archiva o restaura (una sesión con turno en curso no se archiva), `[` `]` la mueven dentro de su espacio |
| Archivos | Explora la carpeta raíz del espacio de la sesión activa (`workspaceFiles/list`). Enter abre una carpeta o un archivo (en páginas de 40 líneas, `[` `]` pasan página); Backspace sube, o cierra la página o la búsqueda. `/` busca por nombre (`workspaceFiles/search`); `h` incluye los ocultos en las búsquedas; `r` recarga. Si el Host corta la lista, se avisa |
| Terminal | Lista las terminales de la sesión activa (`terminal/watch`, en vivo). Enter la abre a pantalla completa; `n` elige shell (`terminal/shells`) y la crea en la carpeta de la sesión; `r` renombra; `x` la cierra (`terminal/close`). Con «terminó (código N)» la terminal ya no corre; Enter sigue mostrando su última pantalla |
| Habilidades | ↑↓ listan las habilidades de la sesión con su descripción |

Terminal a pantalla completa: todas las teclas van a la shell (también Ctrl+C, Esc, Tab y las flechas), salvo **Ctrl+]**, que vuelve al panel. Si el Host marca la terminal de solo lectura, las teclas se avisan y no se envían. Si la conexión cae, la última pantalla se queda y Enter reconecta.

Tarjetas de la sesión activa (aparecen sobre el compositor):

| Tarjeta | Teclas |
|---|---|
| Pregunta del agente | ↑↓ eligen fila · Espacio marca · Enter confirma la pregunta (en la última envía el lote) · Tab/→ y Shift+Tab/← cambian de pregunta · texto libre al escribir · Esc la delega |
| Aprobación de herramienta | `y` permite una vez · `n` rechaza · Esc delega (la herramienta queda sin aprobar) |

Las preguntas o aprobaciones de otra sesión no roban la entrada: se avisan en el cuerpo de la
conversación y se responden al abrir esa sesión.

Nota: Ctrl+M y Ctrl+H no se usan, porque los terminales los envían como Enter y Retroceso.

## Diseño

```
src/
  cli.tsx                 punto de entrada: URL, token, pantalla alternativa, errores en español
  wire/remote.ts          transporte: connect (token → cookie), call (RPC unario), RemoteMux (stream)
  transcript/reducer.ts   reductor puro: eventos durables + frames en vivo → filas de la conversación
  app/session-client.ts   operaciones de sesión sobre la API remota (list, create, prompt, follow, ...)
  app/controller.ts       estado de la aplicación y acciones; sin dependencia de Ink
  app/panel-client.ts     llamadas y normalizadores del panel (cola, permisos, ajustes, metas,
                          programaciones, habilidades); cada respuesta se normaliza antes de la UI
  ui/App.tsx              pantalla: cabecera, barra lateral (anchos ≥ 100 columnas), conversación,
                          compositor, superposiciones, teclas
  ui/Panel.tsx            panel de seis secciones: cabecera y pie fijos, cuerpo con desplazamiento
                          que sigue al cursor y avisa de las líneas ocultas
  ui/panel-keys.ts        teclas del panel: reglas de confirmación y de edición
  ui/keys.ts              tipos de tecla y edición de campos (borrado de ráfagas)
  ui/layout.ts            reglas puras: breakpoint, anchos en celdas (CJK/emoji), ajuste de texto
  ui/format.ts            filas de la transcripción y de la lista de sesiones, ya ajustadas al ancho
  ui/composer.ts          buffer del compositor (cursor por punto de código)
  ui/theme.ts             paleta y glifos
tests/                    node:test; 103 pruebas (ver abajo)
```

Principios de la interfaz:

- **Nada se corta ni se apila.** Todo texto se ajusta al ancho en celdas antes de dibujarse. Las
  teclas se empaquetan por acción completa, y el texto largo se envuelve y ocupa más filas.
- **Adaptativa.** A partir de 100 columnas aparece la barra lateral con las sesiones; por debajo,
  la conversación ocupa todo el ancho. El alto se reparte entre cabecera, cuerpo, compositor y
  teclas, y el cuerpo se ajusta al espacio sobrante.
- **Secretos.** La clave se muestra enmascarada (solo su longitud) y nunca se vuelve a imprimir.
- **Protocolo.** Los mensajes `user/message` que no vienen del usuario (contexto de sistema,
  catálogo de habilidades, hora) se ocultan; el prompt de sistema también.

## Pruebas

```bash
npm ci
npm run typecheck   # tsc --noEmit, modo estricto
npm test            # node:test, 149 pruebas
```

Cobertura: capa wire (conexión, RPC, mux, errores tipados), reductor de la transcripción
(replay por `seq`, turnos, streaming del asistente, herramientas repetidas entre turnos,
errores de herramienta), ajuste de texto en anchos de 14 a 80 celdas, teclas por acción
completa, controlador con un Host simulado (credenciales, catálogo, renombrar, bifurcar,
búsqueda con respaldo, cancelar, seleccionar modelo).

Verificación de extremo a extremo: la interfaz se ejecutó en un pseudo-terminal contra un
servidor real del harness (perfil `jincode`) con un modelo OpenAI-compatible simulado: guardado
de la clave, catálogo, envío con streaming de texto, llamada a la herramienta `bash` con su
salida, renombrar, bifurcar, búsqueda y ayuda, en 44 y 100 columnas. En la fase 5 se añadió:
cancelar un turno con Esc, dirigir un mensaje durante el turno, editarlo y quitarlo, cambiar el
permiso con confirmación para `danger-full-access`, crear, pausar y consultar una meta, y salir con
Ctrl+Q.

Pruebas de la fase 5: `tests/panel.test.ts` (normalizadores y `PanelClient` contra un Host falso
que registra cada llamada), `tests/panel-view.test.ts` (render con `ink-testing-library`: ningún
renglón supera el ancho, desplazamiento del cuerpo, teclas de cada sección) y el flujo del
controlador en `tests/controller.test.ts`.

## Estado por fases

| Fase | Alcance | Estado |
|---|---|---|
| 0 | Retirar la página web del perfil de Termux (API sola) | Hecho (`8821af8`) |
| 1 | Transporte: token → cookie, RPC, mux de streams, errores tipados | Hecho, probado |
| 2 | Sesiones: listar, crear, abrir, seguir, renombrar, bifurcar, buscar, cancelar | Hecho, probado |
| 3 | Conversación: streaming de texto y razonamiento, herramientas, turnos, errores | Hecho, probado |
| 4 | Modelos y credenciales: catálogo, selección, guardar y eliminar claves | Hecho, probado |
| 5 | Cola (dirigir, editar, quitar), permisos, esfuerzo de razonamiento | Hecho, probado en vivo |
| 5b | Panel: ajustes (solo lectura), metas (crear, pausar, reanudar, completar, eliminar), programaciones y habilidades (solo lectura) | Hecho, probado en vivo |
| 6 | Preguntas del agente (`userQuestions`: respuesta por `$events`), adjuntos (`fileUploads/upload`, imagen en el prompt), aprobaciones (`approval/request`) | Hecho en vivo: respuesta a pregunta, aprobar una vez, rechazar. Pendiente en vivo: espera temporizada (`userQuestions/attachWait`) y adjuntos |
| 7a | Ajustes editables (`settings/mutate` por campo con la revisión leída, `settings/replace` por sección sin secretos) | Hecho, probado en vivo |
| 7b | Espacio de trabajo: crear, renombrar, quitar, ordenar, fijar y archivar (`workspace/*`, stream `workspace/follow`) | Hecho, probado en vivo |
| 7c | Archivos del espacio (`workspaceFiles/*`: listar, leer por páginas, buscar) | Hecho, probado en vivo |
| 7d | Terminal (`terminal/*`: shells, crear, adjuntar a pantalla completa con acuses de entrada, renombrar, cerrar, retener, `watch` del listado) | Hecho, probado en vivo |
| 7e | Programaciones completas (`schedule/*`): crear con siete temporizaciones y tres destinos, editar con revisión, pausar o reanudar, ejecutar, historial, eliminar y quitar terminadas | Hecho, probado en vivo |
| 7f | Metas: editar el objetivo (`goals/edit`, con la revisión leída) | Hecho, probado en vivo |
| 7h | Agentes: listar presets, seleccionar en una sesión vacía, sesión nueva con preset, ver la declaración (`agentPresets/*`) | Hecho, probado en vivo |
| 7g | Subagentes: listar los hijos, enviar un mensaje (cola o dirigir), interrumpir (`subagents/*`) | Hecho; probado contra el Host con ids ausentes. Crear un subagente real no fue posible en el entorno de prueba |
| 8 | Plugins (`pluginManager/*`): listar, activar y desactivar plugins y bundles, quitar un bundle (dos pulsaciones), inspeccionar e instalar | Hecho con pruebas (Host simulado). En vivo: listado, lectura e inspección de un paquete sin bundle verificados; activar, quitar e instalar con éxito no (ver abajo) |
| 9 | MCP (`mcpManager/*`): estado en vivo de los servidores, sondeo y reinicio | Hecho, probado en vivo con un servidor MCP de prueba (stdio). Autorización OAuth y edición de `servers` desde Ajustes no se probaron en vivo |

Verificación de la fase 6 en vivo: pregunta con respuesta de opción (turno completo tras
responder), aprobación `y` (la herramienta se ejecuta y el turno termina con «completado») y
rechazo `n` (la herramienta queda denegada). Aprobaciones y preguntas requieren el servidor
con `DSH_PERMISSION_MODE=read-only` para que `bash` pida aprobación, y `JINCODE_BASE_URL`
apuntando al modelo de prueba; sin esa variable el turno falla con «Connection error.».

Fase 7a, verificación en vivo: editar un campo (8 → 9) con revisión 1 → 2 y quitarlo con `u`
(vuelve a 8, sin ✎); `settings/replace` con la revisión actual se acepta y con una revisión
obsoleta el Host responde «changed since it was read».

Fase 7d, verificación en vivo: crear una terminal con `bash` desde el selector; escribir `echo hola-pty`
y ver la salida; Ctrl+C interrumpe `sleep 60` y la shell sigue; `exit` deja «terminó (código 0)» en la
cabecera y en la lista; renombrar («Build»), cerrar con `x` (la lista se actualiza sola) y redimensionar
(`resize` a 90×20 con acuse en orden). Lo que sale de la terminal se confirma con `terminal/attach`:
el snapshot trae la pantalla completa, la primera salida lleva la secuencia snapshot + 1, y cada
escritura recibe su acuse en orden.

Fase 7c, verificación en vivo: listado de la raíz con carpetas primero; búsqueda `editorconfig`
sin ocultos (sin resultados, como indica el Host) y con `h` (1 resultado); apertura del archivo en
su página con numeración.

Fase 7e, verificación en vivo: crear «Prueba-PTY» con `every 3600` y destino «sesión actual»; la lista
la muestra como «activa» con «cada 3600 s». `p` la pausa («pausada») y la reanuda. `h` lista la
entrega `hola-pty` tras `r` (ejecutar ahora). Editar con la temporización `bogus` muestra el aviso
de sintaxis y mantiene el formulario abierto. `x` pide confirmación y la segunda pulsación elimina
(«programación eliminada»). `c` pide confirmación y responde «0 terminadas eliminadas». En el Host,
un cambio con una `updatedAt` obsoleta devuelve `schedule_conflict` y no cambia nada; la CLI lo
muestra como aviso.

Fase 7f, verificación en vivo: `e` abre el objetivo actual en el campo («Objetivo: meta-uno▌»);
Enter con «meta-editada» lo guarda y aparece «meta editada». Las pruebas cubren el caso de una
revisión obsoleta (el Host responde «stale goal ref»): la CLI vuelve a leer la meta y avisa.

Fase 7g, verificación: la sección «Subagentes» aparece en el panel y dice «Esta sesión no tiene
subagentes.» en el servidor de prueba. Contra el Host, `subagents/interruptByUser` con un id ausente
responde `accepted: true` (no-op) y `subagents/prompt` con un id ausente responde «subagent cannot be
resumed». El simulador de modelo no crea subagentes, así que el envío a un hijo real queda cubierto por
las pruebas con Host simulado (`tests/controller.test.ts`, `tests/panel.test.ts`).

Fase 7h, verificación en vivo: la sección «Agentes» lista `standard · por defecto`, `ptc`, `minimal`,
`cordis`; `v` sobre `ptc` muestra su declaración («128 líneas»); Enter en una sesión vacía responde
«agente seleccionado: ptc». Contra el Host, `agentPresets/select` en una sesión con historial responde
«This session has already started», y con un preset desconocido «Unknown agent preset». La CLI no envía
la selección si la sesión activa ya tiene turnos.

Fase 8, verificación: en el servidor de prueba la sección «Plugins» lista primero los bundles
(`@deepseek-ai/dsh-base` y `dsh-web-app`, marcados «solo lectura») y después
los plugins del cargador, con títulos y descripciones de una línea. No se verificó en vivo activar,
desactivar, quitar ni instalar. Motivos: el servidor de prueba dejó de arrancar en este entorno (el
launcher de `dsh` reescribió `profiles/web/package.json` añadiendo `dsh-acp-app` y terminó con
«unknown option '--host'»), y el entorno no alcanza el registro de paquetes (`fetch failed` en
`pluginManager/inspect`). Esas acciones quedan cubiertas por pruebas con un Host simulado
(`tests/panel.test.ts`, `tests/controller.test.ts`, `tests/panel-view.test.ts`).

Corrección de la fase 8: el Host responde a `pluginManager/installBundle` con su resultado de cambio
(`application`, `bundle`, `version`, `error.code`, `pendingBuilds`), no con un `status`. La CLI lo lee
así (`src/app/plugin-install-model.ts`). Antes mostraba «desconocido» y dejaba la inspección en
`accepted`. Ahora un fallo muestra «falló» con su motivo; una instalación correcta, «instalado», y la
inspección se sustituye, así que un Enter más no reinstala. Si pnpm dejó scripts de instalación sin
ejecutar (`pendingBuilds`), la línea los nombra y un Enter con el mismo texto los permite para este
perfil y reinstala (`approvedBuilds`).

Verificación en vivo de esa corrección: `pluginManager/installBundle` sobre un paquete local sin
bundle devolvió `application:'failed'` con `error.code:'not-bundle'`, y el perfil quedó como estaba.
La inspección de ese mismo paquete en el panel lo rechaza antes de instalar («declares no dsh.bundle»).
El éxito de una instalación y la aprobación de scripts no se verificaron en vivo: el entorno de
prueba no alcanza el registro de paquetes.

Fase 9, verificación en vivo: con un servidor MCP de prueba (stdio, una herramienta `echo`) en
Ajustes › mcp-manager, la sección MCP muestra «echo · conectado · 1 herramienta». Con un comando
inexistente, «se agotaron los reintentos» y el error del sistema. `p` sobre ese servidor muestra
«falló en la conexión» con el mismo error; `r` sobre `echo` responde «echo: reiniciado». El sondeo
correcto (con `echo` como herramienta) se comprobó contra el Host. El stream se actualiza sin
recargar: un cambio de estado llega a la lista.

Lo pendiente no está en la interfaz: en esas secciones no hay controles para esas funciones. Cada
fase añade su controlador y sus pruebas sin tocar las anteriores.
