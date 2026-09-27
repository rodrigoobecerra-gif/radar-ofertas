# Radar de ofertas — piloto privado

Busca huellas de infraestructura de vendedores en anuncios activos de Meta: `inlead.digital`, `impultienda`, `systeme.io` y `lovable.app` en Argentina y Brasil. Las ocho combinaciones se definen en `searches.json`. El nicho y el producto digital (ebook, app o plantilla) se clasifican al abrir la página de destino, nunca por el nombre de la plataforma. Meta puede no indexar estas huellas como texto de búsqueda; en tal caso el informe conserva el resultado parcial y no inventa candidatos.

El flujo semanal recorre ocho búsquedas y deja el informe privado en `reports/latest.md` y `reports/latest.json`, además de un artefacto de GitHub Actions. En una solicitud de cambios recorre dos búsquedas para probar el funcionamiento. El muestreo examina el primer bloque, hasta tres resúmenes creativos y tres bibliotecas de anunciantes por búsqueda. Los resúmenes sirven para seleccionar anunciantes, nunca para contar anuncios de una oferta.

Una oferta exige al menos **21 IDs individuales activos** vistos dentro de la biblioteca del mismo anunciante y dirigidos a la **misma URL exacta**. Después se comprueba que la página se abre y muestra titular, precio positivo, acción de compra y señales de producto digital. Cuestionarios sin página de venta y descargas de aplicaciones sin oferta de compra no califican. Si la biblioteca del anunciante no carga, el grupo no califica aunque aparezca en los resultados de búsqueda.

El número en el enlace del perfil de Facebook puede diferir del `view_all_page_id` de Ads Library. El recolector intenta resolverlo mediante la sugerencia de anunciante dentro de Meta y verifica que los anuncios cargados correspondan al mismo perfil. Si esa página devuelve un error o pide sesión, conserva la candidata sin elevarla a oferta verificada.

El recuento demuestra actividad publicitaria observable; no demuestra ventas ni rentabilidad. Meta no publica las visitas a esa URL y una estimación de tráfico del dominio no equivale a visitas de la página. Una falla total de extracción no reemplaza el último informe privado. **Este flujo no actualiza el Site privado por sí solo.**

El informe separa `offers` (umbral confirmado en la biblioteca del anunciante) de `candidates` (página de venta comprobada e IDs vistos solo en resultados de búsqueda). Las candidatas quedan pendientes y jamás se suman al contador de ofertas verificadas.
