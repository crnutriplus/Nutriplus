# Despliegue en ChatGPT Sites

## Fuente del deployment

NutriPlus se publica mediante ChatGPT Sites. `.openai/hosting.json` enlaza el checkout con el proyecto y declara los bindings lógicos D1 (`DB`) y R2 (`BUCKET`). No hay `wrangler.jsonc` ni se usa `wrangler deploy` como flujo de publicación.

La versión pública se controla en `lib/public-version.ts`. `package.json` conserva el equivalente SemVer. El checkpoint y el commit se generan al guardar y no son el número de versión.

## Preparación de un cambio

1. Abrir el proyecto mediante el ciclo de vida de Sites para trabajar sobre el checkout canónico.
2. Inspeccionar `git status`, commits recientes y cambios preexistentes.
3. Implementar el cambio mínimo y actualizar documentación/CHANGELOG.
4. Ejecutar las puertas de calidad de [TESTING.md](TESTING.md).
5. Revisar el diff, especialmente secretos, migraciones y cambios funcionales no solicitados.

En el entorno de ChatGPT Work, la herramienta se invoca desde el skill instalado. Forma general:

```bash
python3 "$SITES_SKILL_DIR/scripts/sites.py" edit --path "$PWD"
python3 "$SITES_SKILL_DIR/scripts/sites.py" checkpoint \
  --path "$PWD" \
  --project-id "$(node -p "require('./.openai/hosting.json').project_id")" \
  --message "Descripción breve del cambio"
```

La ubicación exacta de `SITES_SKILL_DIR` depende de la versión instalada de la herramienta; no se debe hardcodear en el código de NutriPlus.

## Build

El builder remoto ejecuta `npm run build`. Ese comando:

1. prepara rutas escribibles con `scripts/sites-env.sh`;
2. ejecuta `vinext build` con límite de tiempo;
3. valida manifest y export `default.fetch` mediante `scripts/validate-artifact.sh`.

`npm run install:ci` realiza un único `npm ci` bloqueado por lock, comprueba integridad y evita instalaciones concurrentes.

## Publicación y monitoreo

Un checkpoint guarda el código y puede iniciar un deployment. Cuando la tarea autoriza publicar:

1. solicitar/usar la aprobación de publicación indicada por la persona usuaria;
2. crear el checkpoint con un mensaje preciso;
3. esperar un estado terminal del deployment;
4. consultar de nuevo el estado del sitio;
5. verificar que el HTML publicado exponga `NutriPlus vX.Y` y la metadata esperada;
6. para cambios funcionales, comprobar el flujo publicado sin operaciones destructivas ni consumo no autorizado;
7. registrar en el informe versión, checkpoint real, commit completo y URL.

URL de producción actual:

```text
https://nutriplus-precios.ever1822.chatgpt.site
```

La política de acceso debe permanecer restringida. Nunca incruste tokens de bypass en comandos documentados, archivos, capturas o informes.

## Rollback y límites

- Un checkpoint permite identificar/restaurar código, pero no es un backup de D1 ni R2.
- Un rollback de código puede ser incompatible con un esquema ya migrado; revisar migraciones antes de promoverlo.
- No se debe ejecutar una restauración de productos o base de datos como smoke test.
- Si el deployment falla, conservar el checkpoint, recopilar el error seguro, corregir el mismo cambio y volver a ejecutar las puertas afectadas.
- Nunca declarar una versión publicada solo porque el commit existe: verificar el deployment y el HTML real.
