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
| Ctrl+O | Elegir modelo de la sesión (Enter confirma) |
| Ctrl+G | Claves de los proveedores: Tab cambia de proveedor, Enter guarda, Ctrl+D elimina |
| Ctrl+F | Buscar en las sesiones (títulos y carpetas; contenido si el Host lo tiene activo) |
| Ctrl+R | Renombrar la sesión |
| Ctrl+B | Bifurcar la sesión |
| Esc · Ctrl+C | Cancelar el turno en curso (Esc también cierra cualquier superposición) |
| PgUp · PgDn | Desplazar la conversación |
| Ctrl+P · ? | Ayuda con todas las teclas (`?` solo con el mensaje vacío) |
| Ctrl+Q | Salir. La sesión sigue en el Host |

Nota: Ctrl+M y Ctrl+H no se usan, porque los terminales los envían como Enter y Retroceso.

## Diseño

```
src/
  cli.tsx                 punto de entrada: URL, token, pantalla alternativa, errores en español
  wire/remote.ts          transporte: connect (token → cookie), call (RPC unario), RemoteMux (stream)
  transcript/reducer.ts   reductor puro: eventos durables + frames en vivo → filas de la conversación
  app/session-client.ts   operaciones de sesión sobre la API remota (list, create, prompt, follow, ...)
  app/controller.ts       estado de la aplicación y acciones; sin dependencia de Ink
  ui/App.tsx              pantalla: cabecera, barra lateral (anchos ≥ 100 columnas), conversación,
                          compositor, superposiciones, teclas
  ui/layout.ts            reglas puras: breakpoint, anchos en celdas (CJK/emoji), ajuste de texto
  ui/format.ts            filas de la transcripción y de la lista de sesiones, ya ajustadas al ancho
  ui/composer.ts          buffer del compositor (cursor por punto de código)
  ui/theme.ts             paleta y glifos
tests/                    node:test; 65 pruebas (ver abajo)
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
npm test            # node:test, 65 pruebas
```

Cobertura: capa wire (conexión, RPC, mux, errores tipados), reductor de la transcripción
(replay por `seq`, turnos, streaming del asistente, herramientas repetidas entre turnos,
errores de herramienta), ajuste de texto en anchos de 14 a 80 celdas, teclas por acción
completa, controlador con un Host simulado (credenciales, catálogo, renombrar, bifurcar,
búsqueda con respaldo, cancelar, seleccionar modelo).

Verificación de extremo a extremo: la interfaz se ejecutó en un pseudo-terminal contra un
servidor real del harness (perfil `jincode`) con un modelo OpenAI-compatible simulado: guardado
de la clave, catálogo, envío con streaming de texto, llamada a la herramienta `bash` con su
salida, renombrar, bifurcar, búsqueda y ayuda, en 44 y 100 columnas.

## Estado por fases

| Fase | Alcance | Estado |
|---|---|---|
| 0 | Retirar la página web del perfil de Termux (API sola) | Hecho (`8821af8`) |
| 1 | Transporte: token → cookie, RPC, mux de streams, errores tipados | Hecho, probado |
| 2 | Sesiones: listar, crear, abrir, seguir, renombrar, bifurcar, buscar, cancelar | Hecho, probado |
| 3 | Conversación: streaming de texto y razonamiento, herramientas, turnos, errores | Hecho, probado |
| 4 | Modelos y credenciales: catálogo, selección, guardar y eliminar claves | Hecho, probado |
| 5 | Cola de mensajes (editar, quitar, dirigir), selección de esfuerzo de razonamiento | Pendiente |
| 6 | Adjuntos e imágenes; permisos y política de aprobación (`approval/policy`) | Pendiente |
| 7 | Ajustes del Host (`settings/describe`, `settings/update`) y espacio de trabajo (archivos, terminal) | Pendiente |
| 8 | Metas, programaciones, habilidades, subagentes, gestor de plugins | Pendiente |

Las fases 5 a 8 cubren el resto de la interfaz web. Cada una añade su controlador y sus pruebas
sin tocar las anteriores.
