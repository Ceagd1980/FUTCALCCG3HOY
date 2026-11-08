/**
 * Lectura de la lista de partidos (matchlist) del SoccerStats nuevo y cálculo
 * de TODAS las estadísticas por equipo a partir de los resultados.
 *
 * Por qué así: el sitio nuevo de SoccerStats solo muestra gratis los primeros
 * 5 equipos en sus tablas (Goals, Half-time, Streaks...), pero la lista de
 * partidos (matchlist) trae gratis TODOS los resultados con el marcador final
 * y el del primer tiempo. Con eso calculamos aquí mismo lo que antes venía
 * ya hecho: GP/W/D/L/GF/GA (total, casa y fuera), PPG, Over 1.5/2.5/3.5,
 * BTTS, Over del primer tiempo y la racha actual.
 */

const cheerio = require('cheerio');

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const pct = (n, total) => (total ? Math.round((n / total) * 100) : null);
const redondear2 = (x) => Math.round(x * 100) / 100;

/**
 * Del HTML de cualquier página de la liga saca la dirección base, por
 * ejemplo https://www.soccerstats.com/en-gb/leagues/germany/bundesliga/germany
 */
function extraerBase(urlFinal, html) {
  const deUrl = String(urlFinal || '').match(/^(https?:\/\/www\.soccerstats\.com)(?:\/nodeweb)?(\/en-gb\/leagues\/[^/?#]+\/[^/?#]+\/[^/?#]+)/i);
  if (deUrl) return deUrl[1] + deUrl[2];
  const deHtml = String(html || '').match(/https?:\/\/www\.soccerstats\.com(?:\/nodeweb)?(\/en-gb\/leagues\/[^/"'?#]+\/[^/"'?#]+\/[^/"'?#]+)\/matchlist/i);
  if (deHtml) return 'https://www.soccerstats.com' + deHtml[1];
  return null;
}

/**
 * Enlaces de los meses de la liga (matchlist/maug, msep, ...).
 * Devuelve [{ codigo: 'maug', url, activo }] en el orden en que aparecen.
 */
function extraerMeses(html) {
  const $ = cheerio.load(html);
  const vistos = new Set();
  const meses = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/matchlist\/(m[a-z]{3})\/?$/i);
    if (!m) return;
    const codigo = m[1].toLowerCase();
    if (vistos.has(codigo)) return;
    vistos.add(codigo);
    meses.push({ codigo, url: href, activo: $(a).hasClass('is-active') });
  });
  return meses;
}

/**
 * Lee las filas de partidos de una página matchlist.
 * Devuelve [{ id, kickoff (Date, UTC), local, visita, jugado, golesL, golesV, htL, htV }]
 */
function parsearPartidos(html, ahora = new Date()) {
  const $ = cheerio.load(html);
  const partidos = [];

  $('tr').each((_, tr) => {
    const $tr = $(tr);
    const spanFecha = $tr.find('[data-kickoff]').first();
    if (!spanFecha.length) return;

    const kickoffTxt = spanFecha.attr('data-kickoff'); // "2026-11-07 14:30:00" (UTC)
    const kickoff = new Date(kickoffTxt.replace(' ', 'T') + 'Z');
    if (isNaN(kickoff)) return;

    // Equipos: los dos <span> dentro de la celda de "A vs B"
    const celdaEquipos = $tr.find('td[colspan]').first();
    const spans = celdaEquipos.find('span');
    let local = '', visita = '';
    if (spans.length >= 2) {
      local = $(spans[0]).text().trim();
      visita = $(spans[1]).text().trim();
    } else {
      const partes = celdaEquipos.text().replace(/\s+/g, ' ').trim().split(/\s+vs\s+/i);
      if (partes.length === 2) { local = partes[0].trim(); visita = partes[1].trim(); }
    }
    if (!local || !visita) return;

    // Marcador final y del descanso: textos "3:1" y "(1:0)" en las demás celdas
    let res = null, ht = null;
    $tr.find('td').each((__, td) => {
      // La celda con la HORA de un partido futuro (ej. "14:30") no es un marcador
      if ($(td).find('.local-time-convert').length) return;
      const t = $(td).text().replace(/\s+/g, ' ').trim();
      if (!res) {
        const m = t.match(/^(\d{1,2}):(\d{1,2})$/);
        if (m) { res = [parseInt(m[1], 10), parseInt(m[2], 10)]; return; }
      }
      const h = t.match(/^\((\d{1,2}):(\d{1,2})\)$/);
      if (h) ht = [parseInt(h[1], 10), parseInt(h[2], 10)];
    });

    // Un "14:30" suelto en una fila futura NO es un marcador: solo damos por
    // jugado un partido con el descanso entre paréntesis o que ya pasó.
    const yaPaso = kickoff.getTime() < ahora.getTime() - 2 * 60 * 60 * 1000;
    const jugado = Boolean(res && (ht || yaPaso));

    const href = $tr.find('a[href*="/matches/"]').first().attr('href') || '';
    const id = (href.match(/\/matches\/[^/]+\/(\d+)/) || [])[1] || `${kickoffTxt}|${local}|${visita}`;

    partidos.push({
      id, kickoff, local, visita, jugado,
      golesL: jugado ? res[0] : null, golesV: jugado ? res[1] : null,
      htL: jugado && ht ? ht[0] : null, htV: jugado && ht ? ht[1] : null,
    });
  });

  return partidos;
}

/**
 * Calcula, para cada equipo, las mismas estadísticas que el build-radar espera.
 */
function calcularEquipos(partidos) {
  const jugados = partidos
    .filter((p) => p.jugado)
    .sort((a, b) => a.kickoff - b.kickoff);

  const acc = {};
  const nuevo = (nombre) => ({
    nombreOriginal: nombre,
    gp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0,
    wh: 0, dh: 0, lh: 0, gfh: 0, gah: 0,
    wa: 0, da: 0, la: 0, gfa: 0, gaa: 0,
    o15: 0, o25: 0, o35: 0, btts: 0,
    htN: 0, h05: 0, h15: 0, h25: 0,
    resultados: [],
  });

  const sumar = (nombre, esLocal, gf, ga, htTotal) => {
    const k = normalizar(nombre);
    const e = (acc[k] = acc[k] || nuevo(nombre));
    const total = gf + ga;
    const r = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
    e.gp++; e.gf += gf; e.ga += ga;
    if (r === 'W') e.w++; else if (r === 'D') e.d++; else e.l++;
    if (esLocal) {
      e.gfh += gf; e.gah += ga;
      if (r === 'W') e.wh++; else if (r === 'D') e.dh++; else e.lh++;
    } else {
      e.gfa += gf; e.gaa += ga;
      if (r === 'W') e.wa++; else if (r === 'D') e.da++; else e.la++;
    }
    if (total >= 2) e.o15++;
    if (total >= 3) e.o25++;
    if (total >= 4) e.o35++;
    if (gf > 0 && ga > 0) e.btts++;
    if (htTotal !== null) {
      e.htN++;
      if (htTotal >= 1) e.h05++;
      if (htTotal >= 2) e.h15++;
      if (htTotal >= 3) e.h25++;
    }
    e.resultados.push(r);
  };

  for (const p of jugados) {
    const htTotal = p.htL !== null ? p.htL + p.htV : null;
    sumar(p.local, true, p.golesL, p.golesV, htTotal);
    sumar(p.visita, false, p.golesV, p.golesL, htTotal);
  }

  const equipos = {};
  for (const [k, e] of Object.entries(acc)) {
    const ptsTotal = e.w * 3 + e.d;
    const gpH = e.wh + e.dh + e.lh;
    const gpA = e.wa + e.da + e.la;

    // Racha actual: cuántos resultados iguales seguidos hay al final
    let rachaTipo = null, rachaLongitud = 0;
    if (e.resultados.length) {
      rachaTipo = e.resultados[e.resultados.length - 1];
      for (let i = e.resultados.length - 1; i >= 0 && e.resultados[i] === rachaTipo; i--) rachaLongitud++;
    }

    equipos[k] = {
      nombreOriginal: e.nombreOriginal,
      gp: e.gp, w: e.w, d: e.d, l: e.l, gf: e.gf, ga: e.ga,
      pts: ptsTotal,
      ppg: e.gp ? redondear2(ptsTotal / e.gp) : null,
      wh: e.wh, dh: e.dh, lh: e.lh, gfh: e.gfh, gah: e.gah,
      ppgh: gpH ? redondear2((e.wh * 3 + e.dh) / gpH) : null,
      wa: e.wa, da: e.da, la: e.la, gfa: e.gfa, gaa: e.gaa,
      ppga: gpA ? redondear2((e.wa * 3 + e.da) / gpA) : null,
      over15: pct(e.o15, e.gp), over25: pct(e.o25, e.gp), over35: pct(e.o35, e.gp),
      btts: pct(e.btts, e.gp),
      over05HT: pct(e.h05, e.htN), over15HT: pct(e.h15, e.htN), over25HT: pct(e.h25, e.htN),
      rachaTipo, rachaLongitud,
    };
  }
  return equipos;
}

/** Partidos por jugar dentro de los próximos `dias` días (para el radar). */
function proximosPartidos(partidos, dias = 10, ahora = new Date()) {
  const limite = ahora.getTime() + dias * 24 * 60 * 60 * 1000;
  return partidos
    .filter((p) => !p.jugado && p.kickoff.getTime() >= ahora.getTime() - 3 * 60 * 60 * 1000 && p.kickoff.getTime() <= limite)
    .sort((a, b) => a.kickoff - b.kickoff)
    .map((p) => ({ fechaISO: p.kickoff.toISOString(), local: p.local, visita: p.visita }));
}

/** Quita partidos repetidos (la misma fila puede salir en dos páginas). */
function unicos(lista) {
  const vistos = new Map();
  for (const p of lista) if (!vistos.has(p.id)) vistos.set(p.id, p);
  return [...vistos.values()];
}

module.exports = { normalizar, extraerBase, extraerMeses, parsearPartidos, calcularEquipos, proximosPartidos, unicos };
