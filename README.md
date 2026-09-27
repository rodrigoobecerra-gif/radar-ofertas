# Radar de ofertas — piloto privado

Prueba una búsqueda activa de Meta Ads Library en Brasil. Abre un resumen de anuncios, registra solamente IDs individuales activos con destino web visible y agrupa por anunciante y URL exacta. Si un grupo tiene al menos 31 IDs, abre la página y exige título, precio y acción de compra observables.

El resultado queda en el artefacto privado `radar-pilot/pilot.json` de GitHub Actions. El resumen de Meta no se interpreta como cantidad de anuncios de una oferta. El piloto aún no publica resultados en el Site ni está programado: primero debe pasar una ejecución real en GitHub.

No se infieren ventas, gasto o rentabilidad. Una página tipo cuestionario o descarga de app no califica. La cobertura del piloto es una búsqueda y un resumen; el `status` y `scannedIds` muestran si pudo inspeccionarlo.
