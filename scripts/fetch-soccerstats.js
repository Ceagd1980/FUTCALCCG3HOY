/**
 * Para cada liga en config/leagues.js, descarga de SoccerStats.com la LISTA DE
 * PARTIDOS (matchlist) y calcula aquí mismo todas las estadísticas:
 *
 *   - Partidos por jugar (hoy, mañana, próximos días) con su hora.
 *   - Por equipo: GP/W/D/L/GF/GA (total, en casa y fuera), PPG.
 *   - Por equipo: % Over 1.5 / 2.5 / 3.5 y Ambos Anotan (BTTS).
 *   - Por equipo: % Over 0.5 / 1.5 / 2.5 del primer tiempo (HT).
 *   - Por equipo: racha actual (W / D / L y cuántos seguidos).
 *
 * Por qué así: en noviembre de 2026 SoccerStats rediseñó el sitio. Las páginas
 * viejas (table.asp tid=c / tid=g, halftime.asp) dejaron de existir y las
 * tablas nuevas (Goals, Half-time, Streaks) solo muestran gratis los primeros 5
 * equipos. La lista de partidos, en cambio, sigue siendo completa y gratis, e
 * incluye el marcador final y el del primer tiempo de cada partido, así que
 * todo se puede calcular a partir de ella.
 *
 * Cada liga se abre una vez con results.asp?league=X (SoccerStats la redirige
 * sola a la dirección nueva de la lista de partidos) y luego se leen sus meses.
 *
 * SoccerStats bloquea peticiones HTTP simples, por eso se usa Puppeteer +
 * stealth (un Chrome real e invisible).
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const leagues = require('../config/leagues');
const {
  extraerBase, extraerMeses, parsearPartidos, calcularEquipos, proximosPartidos, unicos,
} = require('./lib/matchlist');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const PAUSA_MS = 400;
const DIAS_HACIA_ADELANTE = 10; // cuántos días de partidos futuros se guardan
const LIGAS_ANTES_DE_REINICIAR = 20;
let ligasProcesadasDesdeReinicio = 0;

// Red de seguridad: errores internos de Puppeteer que no pasan por el try/catch
// normal no deben tumbar todo el proceso; se registran y se sigue.
process.on('unhandledRejection', (err) => {
  console.warn(`  [aviso] error interno de Puppeteer ignorado, se continúa: ${err?.message || err}`);
});

let navegador = null;

async function iniciarNavegador() {
  navegador = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 120000,
  });
}

async function cerrarNavegador() {
  if (navegador) await navegador.close();
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Abre una dirección y devuelve { html, urlFinal } (urlFinal = dirección
 * después de las redirecciones, que es como descubrimos la dirección nueva).
 */
async function obtenerPagina(url, { rapido = false } = {}) {
  const pagina = await navegador.newPage();
  try {
    await pagina.setUserAgent(USER_AGENT);
    await pagina.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,es-ES;q=0.8,es;q=0.7' });
    await pagina.setViewport({ width: 1366, height: 900 });

    const respuesta = await pagina.goto(url, {
      waitUntil: rapido ? 'domcontentloaded' : 'networkidle2',
      timeout: 45000,
      referer: 'https://www.soccerstats.com/',
    });
    if (!respuesta) throw new Error(`Sin respuesta al navegar a ${url}`);
    if (!respuesta.ok()) throw new Error(`HTTP ${respuesta.status()} en ${url}`);

    await esperar(rapido ? 300 : 1500);

    const html = await pagina.content();
    if (html.length < 500) {
      throw new Error(`Respuesta sospechosamente corta (${html.length} caracteres) en ${url} — URL final: ${pagina.url()}`);
    }
    return { html, urlFinal: pagina.url() };
  } finally {
    await pagina.close();
  }
}

// ---------- Orquestación por liga ----------

async function procesarLiga(liga) {
  // 1. Entrada: results.asp redirige a la lista de partidos de la dirección nueva.
  let entrada;
  try {
    entrada = await obtenerPagina(`https://www.soccerstats.com/results.asp?league=${liga.slug}`);
  } catch (e) {
    console.warn(`  [${liga.name}] no abrió results.asp: ${e.message}`);
    entrada = await obtenerPagina(`https://www.soccerstats.com/latest.asp?league=${liga.slug}`);
  }

  const base = extraerBase(entrada.urlFinal, entrada.html);
  if (!base) throw new Error(`no se encontró la dirección nueva de la liga (URL final: ${entrada.urlFinal})`);

  // 2. Meses de la temporada: desde el primero hasta el mes activo + 1.
  const meses = extraerMeses(entrada.html);
  let porLeer = meses;
  const iActivo = meses.findIndex((m) => m.activo);
  if (iActivo >= 0) porLeer = meses.slice(0, iActivo + 2);

  let todos = parsearPartidos(entrada.html);
  for (const mes of porLeer) {
    try {
      await esperar(PAUSA_MS);
      const url = mes.url.startsWith('http') ? mes.url : `https://www.soccerstats.com${mes.url}`;
      const pagina = await obtenerPagina(url, { rapido: true });
      todos = todos.concat(parsearPartidos(pagina.html));
    } catch (e) {
      console.warn(`  [${liga.name}] mes ${mes.codigo} falló: ${e.message}`);
    }
  }
  todos = unicos(todos);

  const equipos = calcularEquipos(todos);
  const partidos = proximosPartidos(todos, DIAS_HACIA_ADELANTE);
  return { equipos, partidos };
}

async function main() {
  console.log(`Node ${process.version} — abriendo navegador (Puppeteer)...`);
  await iniciarNavegador();

  try {
    console.log('Probando conexión a SoccerStats.com...');
    let prueba = null;
    for (let intento = 1; intento <= 3; intento++) {
      try {
        prueba = await obtenerPagina('https://www.soccerstats.com/results.asp?league=germany');
        break;
      } catch (err) {
        console.warn(`  Intento ${intento}/3 falló: ${err.message}`);
        if (intento === 3) {
          console.error('\n========================================================');
          console.error('ERROR: no se pudo conectar a soccerstats.com.');
          console.error(`Detalle: ${err.message}`);
          console.error('Puede ser un bloqueo temporal de tu IP o un cambio del sitio.');
          console.error('========================================================\n');
          process.exit(1);
        }
        console.warn('  Esperando 2 minutos antes de reintentar...');
        await esperar(2 * 60 * 1000);
      }
    }
    const baseDePrueba = extraerBase(prueba.urlFinal, prueba.html);
    if (!baseDePrueba) {
      console.error(`ERROR: la página abrió pero no tiene el formato esperado (URL final: ${prueba.urlFinal}).`);
      console.error('SoccerStats pudo haber cambiado su diseño otra vez.');
      process.exit(1);
    }
    console.log(`Conexión OK (${baseDePrueba}).\n`);

    const ligasResultado = {};

    for (const liga of leagues) {
      console.log(`Procesando ${liga.name} (${liga.slug})...`);
      let datos;
      try {
        datos = await procesarLiga(liga);
      } catch (e) {
        console.warn(`  [${liga.name}] se saltó por error: ${e.message}`);
        datos = { equipos: {}, partidos: [] };
      }
      ligasResultado[liga.slug] = { nombre: liga.name, region: liga.region, ...datos };
      console.log(`  -> ${Object.keys(datos.equipos).length} equipos, ${datos.partidos.length} partidos próximos`);
      await esperar(PAUSA_MS);

      // Respaldo parcial tras cada liga, por si el proceso se corta.
      const outPath = path.join(__dirname, '..', 'public', 'data', 'soccerstats.json');
      fs.writeFileSync(outPath, JSON.stringify({ generadoEn: new Date().toISOString(), ligas: ligasResultado }, null, 2));

      ligasProcesadasDesdeReinicio++;
      if (ligasProcesadasDesdeReinicio >= LIGAS_ANTES_DE_REINICIAR) {
        console.log('  [info] reiniciando el navegador para liberar memoria...');
        await cerrarNavegador();
        await iniciarNavegador();
        ligasProcesadasDesdeReinicio = 0;
      }
    }

    console.log('Guardado completo en public/data/soccerstats.json');
  } finally {
    await cerrarNavegador();
  }
}

main().catch(async (e) => {
  console.error('Fallo fatal en fetch-soccerstats.js:', e);
  await cerrarNavegador();
  process.exit(1);
});
