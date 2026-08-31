# Contrato CHATGPT_IMPORT

La importación conserva una factura como borrador revisable y no modifica inventario hasta su confirmación. El JSON puede incluir `gross_subtotal`, `discount_total`/`global_discount`, `net_products_total` y una lista `payments` con `amount`, `currency`, `method`, `last4`, `date` y `cash_affecting`.

## Costos y descuentos

- Una línea puede aportar `gross_subtotal`, `explicit_line_discount` y `net_line_cost`.
- Los descuentos explícitos permanecen en su línea.
- Un descuento global se reparte proporcionalmente entre las líneas elegibles y los centavos residuales se asignan por mayor resto. La suma neta debe coincidir exactamente con el total declarado.
- Las líneas personales/omitidas se conservan para conciliación, pero no generan costo ni salida financiera del negocio.

## Pagos

- Una factura importada por ChatGPT queda marcada `PAID` solo cuando los pagos normalizados suman exactamente su total y moneda.
- Se admiten pagos divididos. Tarjeta y otros medios de efectivo/caja generan salidas separadas; `Store Credit` se conserva como medio no monetario y no reduce caja.
- Al confirmar inventario, el ledger financiero existente reconoce únicamente la fracción de cada línea de negocio que quedó activa en ese ingreso. Cada componente usa una clave por documento, línea, operación y medio; reintentos no duplican movimientos y una reversa agrega su contrapartida append-only enlazada al original.
- La fecha financiera es el día de confirmación/ingreso en NutriPlus (`America/Costa_Rica`); la fecha impresa permanece separada como fecha original del documento.
- Solo se persisten procedencia segura, método normalizado y últimos cuatro dígitos. Nunca se guardan PAN completo, CVV, PIN, claves ni texto sensible sin depurar.

Si el paquete no trae desglose de pagos, se conserva un único pago normalizado como `No especificado` por el total de la factura. No se realizan llamadas a OpenAI durante esta importación.

## Selección canónica durante la revisión

- El texto, cantidad, precio, proveedor y SKU extraídos siguen siendo datos originales de factura.
- La identidad que recibe inventario es el producto canónico seleccionado explícitamente. Se priorizan UPC/EAN/GTIN, `provider + supplier_sku`/alias confirmado y otros identificadores fuertes; marca, presentación, tokens y similitud solo ordenan ayuda visual.
- La presentación se guarda en formato comercial corto y métrico cuando es posible. Cambiar de módulo conserva el borrador de la factura durante la sesión; una recarga puede restaurarlo desde su documento persistido.
