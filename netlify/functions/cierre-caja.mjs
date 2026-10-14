// netlify/functions/cierre-caja.mjs
// Cierre automático de la caja todos los días a las 00:00 de Paraguay (03:00 UTC).
// Calcula el saldo corrido desde "movimientos" y guarda/actualiza cierresCaja/{fecha}
// para cada día ya terminado. La app hace el mismo cálculo al abrirse, así que si esta
// función falla un día, el registro igual queda completo la próxima vez que se abra la app.

const DB = 'https://tienda-total-py-default-rtdb.firebaseio.com';

const hoyPY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' });
const addDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const esGasto = m => m.categoria === 'gasto' || m.categoria === 'retiro';
const ADS_DESDE = '2026-10-14'; // desde acá el gasto de Meta Ads entra solo a la caja
const esVenta = p => p && (p.estado === 'confirmado' || p.estado === 'entregado');
const fechaVenta = p => p.fechaConfirmado || p.fecha || '';

export default async () => {
  const [movRes, ciRes, adsRes, pedRes] = await Promise.all([
    fetch(`${DB}/movimientos.json`), fetch(`${DB}/cierresCaja.json`), fetch(`${DB}/gastoAds.json`), fetch(`${DB}/pedidos.json`),
  ]);
  if (!movRes.ok) return new Response('No pude leer movimientos: ' + movRes.status, { status: 500 });
  const movObj = (await movRes.json()) || {};
  const cierres = (ciRes.ok ? await ciRes.json() : null) || {};
  const gastoAds = (adsRes.ok ? await adsRes.json() : null) || {};
  const pedidos = Object.values((pedRes.ok ? await pedRes.json() : null) || {});
  const adsDia = f => Math.round((gastoAds[f] && Number(gastoAds[f].spend)) || 0);

  // Gasto de Meta Ads de cada día cerrado → gasto "Publicidad" en la caja (clave fija, sin duplicados)
  const hoy0 = hoyPY(), adsUpd = {};
  // Desactivado: Meta se paga con la tarjeta GNB, el gasto va a la deuda de la tarjeta y no a la caja
  for (const f of []) {
    if (f < ADS_DESDE || f >= hoy0) continue;
    const monto = adsDia(f), key = 'ads_' + f, prev = movObj[key];
    if (monto > 0 && (!prev || Math.round(prev.monto) !== monto)) {
      adsUpd[key] = { id: key, fecha: f, categoria: 'gasto', tipo: 'publicidad', rubroId: 'publicidad', label: 'Publicidad', met: 'tr',
        monto, desc: 'Meta Ads del día (automático)', auto: true, creadoEn: (prev && prev.creadoEn) || new Date().toISOString() };
    }
  }
  if (Object.keys(adsUpd).length) {
    await fetch(`${DB}/movimientos.json`, { method: 'PATCH', body: JSON.stringify(adsUpd) });
    Object.assign(movObj, adsUpd);
  }
  const movimientos = Object.values(movObj);

  const movs = movimientos
    .filter(m => m && m.fecha && !isNaN(parseFloat(m.monto)))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : String(a.id || '').localeCompare(String(b.id || ''))));

  const dias = {};
  let saldo = 0;
  for (const m of movs) {
    let d = dias[m.fecha];
    if (!d) d = dias[m.fecha] = { ant: saldo, ing: 0, gst: 0, aj: 0, n: 0, fin: saldo };
    const v = parseFloat(m.monto) || 0;
    d.n++;
    if (m.categoria === 'ingreso') { saldo += v; d.ing += v; }
    else if (esGasto(m)) { if (m.met !== 'gnb') { saldo -= v; d.gst += v; } } // pagado con tarjeta GNB: no toca la caja
    else if (m.categoria === 'ajuste') { d.aj += v - saldo; saldo = v; }
    d.fin = saldo;
  }

  const fechas = Object.keys(dias).sort();
  const hoy = hoyPY();
  if (!fechas.length || fechas[0] >= hoy) return new Response('Nada para cerrar');

  const ahora = new Date().toISOString();
  const campos = ['saldoAnterior', 'ingresos', 'gastos', 'ajuste', 'saldoFinal', 'cantMov', 'ventas', 'facturado', 'ads'];
  const updates = {};
  let ult = 0, f = fechas[0], guard = 0;
  while (f < hoy && guard++ < 3000) {
    const d = dias[f] || { ant: ult, ing: 0, gst: 0, aj: 0, n: 0, fin: ult };
    const rec = {
      fecha: f, saldoAnterior: Math.round(d.ant), ingresos: Math.round(d.ing), gastos: Math.round(d.gst),
      ajuste: Math.round(d.aj), saldoFinal: Math.round(d.fin), cantMov: d.n,
    };
    // Ventas = todas las ventas de la app (no solo web); costo por venta sobre ese total
    const vs = pedidos.filter(p => esVenta(p) && fechaVenta(p) === f);
    rec.ventas = vs.length;
    rec.facturado = Math.round(vs.reduce((s, p) => s + (p.montoFinal || 0), 0));
    rec.ads = adsDia(f);
    rec.costoPorVenta = vs.length ? Math.round(rec.ads / vs.length) : 0;
    const prev = cierres[f];
    if (!prev || campos.some(k => (prev[k] || 0) !== rec[k])) {
      rec.auto = true;
      rec.cerradoEn = (prev && prev.cerradoEn) || ahora;
      if (prev) rec.actualizadoEn = ahora;
      updates[f] = rec;
    }
    ult = d.fin;
    f = addDias(f, 1);
  }

  const n = Object.keys(updates).length;
  if (n) {
    const r = await fetch(`${DB}/cierresCaja.json`, { method: 'PATCH', body: JSON.stringify(updates) });
    if (!r.ok) return new Response('No pude guardar cierres: ' + r.status, { status: 500 });
  }
  return new Response(`Cierres guardados/actualizados: ${n}`);
};

// 03:00 UTC = 00:00 en Paraguay (UTC-3 todo el año)
export const config = { schedule: '0 3 * * *' };
