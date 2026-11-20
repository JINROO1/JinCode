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
| Ctrl+T | Panel: cola, permisos, ajustes, metas, programaciones y habilidades (ver abajo) |
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
| Metas | Sin meta: escribe el objetivo y Enter la crea. Con meta: `p` pausa, `r` reanuda, `c` completa, `x` elimina (con el campo vacío) |
| Programaciones | ↑↓ listan las tareas programadas. Solo lectura |
| Habilidades | ↑↓ listan las habilidades de la sesión con su descripción |

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
| 7b | Espacio de trabajo (`workspace/*`: crear, renombrar, fijar, archivar; `workspaceFiles/*`); terminal (`terminal/*`) | Pendiente |
| 8 | Programaciones (`schedule/create`, `edit`, `run`, `history`); metas editar (`goals/edit`); subagentes (`subagents/prompt`, `interruptByUser`); agentes (`agentPresets/*`); plugins (`pluginManager/*`); MCP (`mcpManager/*`) | Pendiente |

Verificación de la fase 6 en vivo: pregunta con respuesta de opción (turno completo tras
responder), aprobación `y` (la herramienta se ejecuta y el turno termina con «completado») y
rechazo `n` (la herramienta queda denegada). Aprobaciones y preguntas requieren el servidor
con `DSH_PERMISSION_MODE=read-only` para que `bash` pida aprobación, y `JINCODE_BASE_URL`
apuntando al modelo de prueba; sin esa variable el turno falla con «Connection error.».

Fase 7a, verificación en vivo: editar un campo (8 → 9) con revisión 1 → 2 y quitarlo con `u`
(vuelve a 8, sin ✎); `settings/replace` con la revisión actual se acepta y con una revisión
obsoleta el Host responde «changed since it was read».

Lo pendiente no está en la interfaz: en esas secciones no hay controles para esas funciones. Cada
fase añade su controlador y sus pruebas sin tocar las anteriores.
