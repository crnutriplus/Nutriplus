# Fixtures de importación de hojas de cálculo

Estos archivos son sintéticos y no contienen información personal ni datos reales de NutriPlus.
Cubren formatos compatibles, selección de hojas, límites, archivos dañados, estructuras ZIP anómalas,
fórmulas, caracteres españoles, códigos de barras y el límite operativo de 5.000 productos.

Se regeneran de forma determinista con:

```bash
node tests/fixtures/spreadsheets/generate-fixtures.mjs
```

El generador utiliza la copia oficial versionada de SheetJS CE declarada por el proyecto. Los archivos
con estructura ZIP anómala se crean únicamente para comprobar que la validación los bloquee antes del parseo.
