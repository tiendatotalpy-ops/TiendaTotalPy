// netlify/functions/gasto-meta.mjs
// Cada 2 horas trae de Meta el gasto diario de la cuenta publicitaria (hoy + 3 días anteriores,
// hora de Paraguay) y lo guarda en gastoAds/{fecha}. Corre en Netlify: no depende de ninguna compu.
// Meta se paga con la tarjeta GNB: la app suma este gasto a la deuda de la tarjeta, NO a la caja.
// Requiere la variable de entorno META_ADS_TOKEN (token con permiso ads_read) en Netlify.

const DB = 'https://tienda-total-py-default-rtdb.firebaseio.com';
const AD_ACCOUNT = '501646525798527';
const API = 'https://graph.facebook.com/v21.0';

const hoyPY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' });
const addDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export default async () => {
  const TOKEN = process.env.META_ADS_TOKEN;
  if (!TOKEN) return new Response('Falta configurar META_ADS_TOKEN en Netlify', { status: 500 });

  const hasta = hoyPY(), desde = addDias(hasta, -3);
  const qs = new URLSearchParams({
    level: 'account', fields: 'spend', time_increment: '1',
    time_range: JSON.stringify({ since: desde, until: hasta }), access_token: TOKEN,
  });
  const r = await fetch(`${API}/act_${AD_ACCOUNT}/insights?${qs}`);
  const j = await r.json();
  if (!r.ok || j.error) return new Response('Meta falló: ' + JSON.stringify(j.error || r.status), { status: 502 });

  const porFecha = {};
  for (const row of j.data || []) porFecha[row.date_start] = Math.round(Number(row.spend) || 0);

  const ahora = new Date().toISOString(), updates = {};
  for (let f = desde; f <= hasta; f = addDias(f, 1)) {
    updates[f] = { spend: porFecha[f] || 0, actualizado: ahora, fuente: 'meta-auto' };
  }
  const w = await fetch(`${DB}/gastoAds.json`, { method: 'PATCH', body: JSON.stringify(updates) });
  if (!w.ok) return new Response('No pude guardar gastoAds: ' + w.status, { status: 500 });
  return new Response('gastoAds actualizado: ' + JSON.stringify(updates));
};

// Cada 2 horas, en el minuto 10
export const config = { schedule: '10 */2 * * *' };
