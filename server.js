import express from "express";
import crypto from "node:crypto";

const {
  MERCHANT_ACCOUNT,
  MERCHANT_PASSWORD,
  QDR_API_BASE = "https://api.qdr6wy.im",
  QDR_SDK_URL = "https://api.qdr6wy.im/js/checkout.js",
  PUBLIC_BASE_URL = "http://localhost:3000",
  CHECKOUT_SIGNING_SECRET = "dev-secret",
  SHOP_NAME = "COZIYA®",
  PORT = 3000,
  MOCK_MODE = "false",
} = process.env;

const MOCK = String(MOCK_MODE).toLowerCase() === "true";
// qdr6wy n'accepte que l'USD : on force la devise envoyee au PSP (l'affichage client reste libre).
const QDR_CURRENCY = String(process.env.QDR_CURRENCY || "USD").toUpperCase();

// Upsell post-achat (1 clic, recharge la carte via son bill token, sans 3DS).
const UPSELL_AMOUNT = Number(process.env.UPSELL_AMOUNT || 39.99);
const UPSELL_REF_PRICE = Number(process.env.UPSELL_REF_PRICE || 69.99);
const UPSELL_SAVE = (UPSELL_REF_PRICE - UPSELL_AMOUNT).toFixed(2);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const transactions = new Map();

function sign(payload) {
  return crypto.createHmac("sha256", CHECKOUT_SIGNING_SECRET).update(payload).digest("hex");
}
function buildSignedPayload({ amount, currency, orderRef }) {
  return `${orderRef}|${amount}|${currency}`;
}
function sanitizeShop(s) {
  if (!s) return "";
  return String(s).replace(/[<>"`]/g, "").trim().slice(0, 40);
}
function verifySignature(q) {
  const { amount, currency, order_ref, sig } = q;
  if (!amount || !currency || !order_ref || !sig) return false;
  const expected = sign(buildSignedPayload({ amount, currency, orderRef: order_ref }));
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

async function callQdr(pathname, body) {
  if (MOCK) return mockQdr(pathname);
  const res = await fetch(`${QDR_API_BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { status: "error", message: `Reponse non-JSON (${res.status}): ${text.slice(0, 300)}` }; }
}

function mockQdr(pathname) {
  if (pathname.endsWith("/init")) {
    return { session_id: "mock-" + crypto.randomUUID(),
      payload: { session_token: crypto.randomUUID(), team_id: "team_mock123", app_id: "app_mock456" },
      status: "success", code: 0, message: "success (mock)" };
  }
  if (pathname.endsWith("/complete")) {
    return { status: "success", code: 0, message: "success (mock)",
      token: crypto.randomUUID() + crypto.randomUUID().slice(0, 4) };
  }
  if (pathname.endsWith("/sale/token")) {
    return { status: "success", code: 0, message: "success (mock)",
      payload: { transaction_status: "SUCCESS", token: crypto.randomUUID() } };
  }
  return { status: "error", message: "mock: route inconnue" };
}

app.get("/health", (_req, res) => res.json({ ok: true, mock: MOCK }));

app.get("/start", (req, res) => {
  const { amount, currency } = req.query;
  let order_ref = req.query.order_ref;
  if (!amount || !currency) return res.status(400).send("Parametres manquants.");
  if (!order_ref || !String(order_ref).trim()) order_ref = "cart-" + crypto.randomUUID();
  const sig = sign(buildSignedPayload({ amount, currency, orderRef: order_ref }));
  const items = req.query.items ? `&items=${encodeURIComponent(req.query.items)}` : "";
  const shop = req.query.shop ? `&shop=${encodeURIComponent(req.query.shop)}` : "";
  const ship = req.query.ship ? `&ship=${encodeURIComponent(req.query.ship)}` : "";
  res.redirect(`/checkout?amount=${encodeURIComponent(amount)}&currency=${encodeURIComponent(currency)}&order_ref=${encodeURIComponent(order_ref)}&sig=${sig}${items}${shop}${ship}`);
});

app.get("/checkout", (req, res) => {
  if (!verifySignature(req.query)) return res.status(400).send("Lien de paiement invalide ou expire.");
  const brand = sanitizeShop(req.query.shop) || SHOP_NAME;
  const isEvent = /rock|event|billet|ticket/i.test(req.query.shop || "");
  const shipParam = req.query.ship ? String(req.query.ship).replace(/[<>"`]/g, "").slice(0, 80) : "";
  const shipping = shipParam || (isEvent
    ? "🎟️ E-Ticket · Livraison instantanée par e-mail"
    : "🚚 DHL · Livraison en 2 jours ouvrés");
  res.type("html").send(CHECKOUT_HTML.replace(/__SHOP_NAME__/g, brand).replace(/__SHIPPING__/g, shipping));
});

app.get("/return", (req, res) => {
  const brand = sanitizeShop(req.query.shop) || SHOP_NAME;
  res.type("html").send(RETURN_HTML.replace(/__SHOP_NAME__/g, brand));
});

app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(
    `window.CHECKOUT_CONFIG = ${JSON.stringify({ sdkUrl: QDR_SDK_URL, apiBase: PUBLIC_BASE_URL })};`
  );
});

// Recupere team_id/app_id (constantes marchand) pour afficher le module carte des le chargement.
// Une init "placeholder" est faite une seule fois puis mise en cache (session abandonnee, jamais debitee).
let cachedSdk = null;
async function getSdkIds() {
  if (cachedSdk) return cachedSdk;
  if (MOCK) { cachedSdk = { team_id: "team_mock123", app_id: "app_mock456" }; return cachedSdk; }
  let host = "checkout.local";
  try { host = new URL(PUBLIC_BASE_URL).hostname; } catch {}
  const data = await callQdr("/v2/cc/sale3d/init", {
    merchant_account: MERCHANT_ACCOUNT, merchant_password: MERCHANT_PASSWORD,
    transaction_unique_id: crypto.randomUUID(), amount: 1, currency: QDR_CURRENCY,
    first_name: "Client", last_name: "Client", address: "", city: "", state: "", zip: "",
    country: "FRA", user_phone: "", user_email: "checkout@" + host, user_ip: "0.0.0.0",
    callback_url: `${PUBLIC_BASE_URL}/api/webhook`, redirect_url: `${PUBLIC_BASE_URL}/return`,
  });
  if (data.status === "success" && data.payload) {
    cachedSdk = { team_id: data.payload.team_id, app_id: data.payload.app_id };
  }
  return cachedSdk;
}
app.get("/api/sdk", async (_req, res) => {
  try {
    const ids = await getSdkIds();
    if (!ids) return res.status(502).json({ status: "error", message: "SDK indisponible" });
    res.json({ status: "success", team_id: ids.team_id, app_id: ids.app_id });
  } catch (e) { res.status(500).json({ status: "error", message: e.message }); }
});

app.post("/api/init", async (req, res) => {
  try {
    const { amount, currency, order_ref, sig, customer, shop } = req.body || {};
    if (!verifySignature({ amount, currency, order_ref, sig }))
      return res.status(400).json({ status: "error", message: "Signature montant invalide." });
    const transaction_unique_id = crypto.randomUUID();
    const c = customer || {};
    const initBody = {
      merchant_account: MERCHANT_ACCOUNT, merchant_password: MERCHANT_PASSWORD,
      transaction_unique_id, amount: Number(amount), currency: QDR_CURRENCY,
      first_name: c.first_name || "", last_name: c.last_name || "", address: c.address || "",
      city: c.city || "", state: c.state || "", zip: c.zip || "", country: c.country || "",
      user_phone: c.phone || "", user_email: c.email || "",
      user_ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
      callback_url: `${PUBLIC_BASE_URL}/api/webhook`,
      redirect_url: `${PUBLIC_BASE_URL}/return?txn=${transaction_unique_id}` + (shop ? `&shop=${encodeURIComponent(shop)}` : ""),
    };
    const data = await callQdr("/v2/cc/sale3d/init", initBody);
    if (data.status !== "success" || !data.payload)
      return res.status(502).json({ status: "error", message: data.message || "init a echoue", raw: data });
    transactions.set(transaction_unique_id, {
      orderRef: order_ref, amount: Number(amount), currency, status: "initiated",
      sessionToken: data.payload.session_token,
      customer: {
        first_name: c.first_name || "", last_name: c.last_name || "", email: c.email || "",
        country: c.country || "", address: c.address || "", city: c.city || "",
        state: c.state || "", zip: c.zip || "", phone: c.phone || "",
      },
      userIp: initBody.user_ip,
      shop: shop || "",
    });
    res.json({ status: "success", transaction_unique_id,
      session_token: data.payload.session_token, team_id: data.payload.team_id, app_id: data.payload.app_id });
  } catch (e) { console.error("init error", e); res.status(500).json({ status: "error", message: e.message }); }
});

app.post("/api/complete", async (req, res) => {
  try {
    const { transaction_unique_id, session_token, card_token, encrypted_cvv, bin, last4,
      card_holder, card_exp_month, card_exp_year } = req.body || {};
    const txn = transactions.get(transaction_unique_id);
    if (!txn) return res.status(404).json({ status: "error", message: "Transaction inconnue/expiree." });
    const data = await callQdr("/v2/cc/sale3d/complete", {
      session_token, card_token, encrypted_cvv, bin, last4, card_holder, card_exp_month, card_exp_year });
    txn.status = data.status || "unknown";
    const bt = data.token || (data.payload && data.payload.token) || data.bill_token || null;
    if (bt) txn.billToken = bt;
    transactions.set(transaction_unique_id, txn);
    const acsUrl = data.acs_url || data.acsUrl || data.redirect || (data.payload && data.payload.acs_url);
    res.json({ status: data.status, code: data.code, message: data.message, acs_url: acsUrl || null });
  } catch (e) { console.error("complete error", e); res.status(500).json({ status: "error", message: e.message }); }
});

app.post("/api/webhook", async (req, res) => {
  try {
    const payload = req.body || {};
    console.log("WEBHOOK qdr6wy:", JSON.stringify(payload));
    // TODO SECURITE : verifier la signature/HMAC du webhook selon la doc qdr6wy avant de faire confiance.
    const id = payload.transaction_unique_id || payload.transactionUniqueId;
    const txn = id ? transactions.get(id) : null;
    if (txn) {
      txn.status = payload.status || txn.status;
      const bt = payload.token || (payload.payload && payload.payload.token) || payload.bill_token || null;
      if (bt) txn.billToken = bt;
      transactions.set(id, txn);
    }
    res.json({ received: true });
  } catch (e) { console.error("webhook error", e); res.status(200).json({ received: true }); }
});

app.get("/api/status", (req, res) => {
  const txn = transactions.get(req.query.txn);
  if (!txn) return res.status(404).json({ status: "unknown" });
  res.json({
    status: txn.status, amount: txn.amount, currency: txn.currency,
    upsell: !!txn.billToken && !txn.upsellDone && (!txn.shop || /coziya/i.test(txn.shop)),
    upsellDone: !!txn.upsellDone,
    upsellAmount: UPSELL_AMOUNT, upsellSave: UPSELL_SAVE, upsellRef: UPSELL_REF_PRICE,
  });
});

// Upsell post-achat : recharge la carte deja utilisee (bill token) sans 3DS.
app.post("/api/upsell", async (req, res) => {
  try {
    const id = (req.body || {}).txn;
    const txn = transactions.get(id);
    if (!txn) return res.status(404).json({ status: "error", message: "Transaction inconnue." });
    const ok = ["success", "approved", "completed", "paid"].includes(String(txn.status || "").toLowerCase());
    if (!ok) return res.status(400).json({ status: "error", message: "Paiement initial non confirme." });
    if (!txn.billToken) return res.status(400).json({ status: "error", message: "Carte non reutilisable (token absent)." });
    if (txn.upsellDone) return res.json({ status: "success", message: "Deja ajoute." });
    const c = txn.customer || {};
    const body = {
      merchant_account: MERCHANT_ACCOUNT, merchant_password: MERCHANT_PASSWORD,
      amount: UPSELL_AMOUNT.toFixed(2), currency: QDR_CURRENCY,
      first_name: c.first_name || "", last_name: c.last_name || "",
      country: c.country || "", user_email: c.email || "",
      address: c.address || "", city: c.city || "", state: c.state || "", zip: c.zip || "",
      token: txn.billToken,
      transaction_unique_id: crypto.randomUUID(),
      user_ip: txn.userIp || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
    };
    const data = await callQdr("/v2/cc/sale/token", body);
    const s = String(data.status || "").toLowerCase();
    const okPay = s === "success" || s === "approved" || data.code === 0
      || (data.payload && String(data.payload.transaction_status || "").toUpperCase() === "SUCCESS");
    if (okPay) {
      txn.upsellDone = true; transactions.set(id, txn);
      return res.json({ status: "success", message: "Upsell debite." });
    }
    return res.status(502).json({ status: "error", message: data.message || "Upsell refuse.", raw: data });
  } catch (e) { console.error("upsell error", e); res.status(500).json({ status: "error", message: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Checkout server sur ${PUBLIC_BASE_URL} (port ${PORT}) — mock=${MOCK}`);
});

const COUNTRY_OPTIONS = [
  ["FRA","France"],["BEL","Belgique"],["CHE","Suisse"],["LUX","Luxembourg"],["MCO","Monaco"],
  ["CAN","Canada"],["DEU","Allemagne"],["ESP","Espagne"],["ITA","Italie"],["PRT","Portugal"],
  ["NLD","Pays-Bas"],["GBR","Royaume-Uni"],["IRL","Irlande"],["USA","Etats-Unis"],["AUT","Autriche"],
  ["POL","Pologne"],["SWE","Suede"],["DNK","Danemark"],["NOR","Norvege"],["FIN","Finlande"],
  ["GRC","Grece"],["MAR","Maroc"],["DZA","Algerie"],["TUN","Tunisie"],["SEN","Senegal"],
  ["CIV","Cote d'Ivoire"],["AUS","Australie"],["JPN","Japon"]
].map(c => `<option value="${c[0]}">${c[1]}</option>`).join("");

const CHECKOUT_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Paiement - __SHOP_NAME__</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;color:#1a1a1a;background:#fff}
.topbar{border-bottom:1px solid #e3e3e3;padding:20px 0}
.topbar-in{max-width:1180px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between}
.shop{font-size:24px;font-weight:700}
.bag{color:#2563eb}
.wrap{max-width:1180px;margin:0 auto;display:flex;flex-wrap:wrap}
.col-form{flex:1 1 560px;padding:40px 56px 60px 24px}
.col-sum{flex:1 1 440px;background:#fafafa;border-left:1px solid #e3e3e3;padding:40px 24px 60px 48px}
@media(max-width:900px){.col-form,.col-sum{flex:1 1 100%;padding:28px 20px}.col-sum{order:-1;border-left:none;border-bottom:1px solid #e3e3e3}}
h2{font-size:19px;font-weight:600;margin:28px 0 14px}
.head-row{display:flex;align-items:baseline;justify-content:space-between;margin:28px 0 14px}
.head-row h2{margin:0}
.link{color:#2563eb;font-size:14px;text-decoration:none}
.ff{position:relative;margin-bottom:12px}
.ff input,.ff select{width:100%;height:54px;border:1px solid #898f94;border-radius:8px;background:#fff;font-size:15px;color:#1a1a1a;outline:none;padding:18px 13px 4px;font-family:inherit}
.ff input::placeholder{color:transparent}
.ff label{position:absolute;left:13px;top:17px;color:#6b7280;font-size:15px;pointer-events:none;transition:all .12s ease}
.ff input:focus~label,.ff input:not(:placeholder-shown)~label,.ff.sel label{top:8px;font-size:11px}
.ff input:focus,.ff select:focus{border-color:#1a1a1a;box-shadow:0 0 0 1px #1a1a1a}
.ff .ic{position:absolute;right:13px;top:18px;color:#8a8a8a}
.row2{display:flex;gap:12px}.row2>.ff{flex:1}
.check{display:flex;align-items:center;gap:9px;font-size:14px;color:#454545;margin:4px 0 8px}
.muted{font-size:13px;color:#6b7280;margin-bottom:12px}
.ship{border:1px solid #2563eb;background:#f4f7ff;border-radius:8px;padding:16px;display:flex;align-items:center;gap:12px;font-size:14px}
.ship .dot{width:18px;height:18px;border-radius:50%;border:5px solid #2563eb}
.ship .free{margin-left:auto;font-weight:500}
.paybox{border:1px solid #2563eb;border-radius:8px;overflow:hidden}
.paybox-head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:#f4f7ff;font-size:14px;font-weight:500}
.paybox-head .dot{width:18px;height:18px;border-radius:50%;border:5px solid #2563eb}
.brands{margin-left:auto;display:flex;gap:5px}
.brand{font-size:10px;font-weight:700;color:#fff;border-radius:3px;padding:3px 5px;letter-spacing:.02em}
.b-visa{background:#1a1f71}.b-mc{background:#eb001b}.b-amex{background:#2e77bc}
.paybox-body{padding:16px}
#card-container{min-height:46px}
#card-container iframe{display:block;width:100%;border:none;height:150px!important;min-height:0}
#card-ph{font-size:13px;color:#6b7280;padding:14px;border:1px dashed #cfcfcf;border-radius:8px;text-align:center}
.error{font-size:13px;color:#d82c0d;min-height:18px;margin:10px 0}
.btn{width:100%;padding:16px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;font-family:inherit;cursor:pointer;margin-top:18px}
.btn:disabled{opacity:.55;cursor:default}
.sum-item{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.sum-thumb{position:relative;width:60px;height:60px;border-radius:8px;background:#ececec;border:1px solid #ddd;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
.sum-qty{position:absolute;top:-8px;right:-8px;background:#5f5f5f;color:#fff;font-size:11px;min-width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center}
.sum-item .nm{font-size:14px;font-weight:500}.sum-item .sub{font-size:12px;color:#6b7280}
.sum-item .pr{margin-left:auto;font-size:14px;font-weight:500}
.sumline{display:flex;justify-content:space-between;font-size:14px;color:#3a3a3a;margin:10px 0}
.sumtotal{display:flex;justify-content:space-between;align-items:baseline;font-size:22px;font-weight:600;margin-top:14px}
.sumtotal .cur{font-size:13px;color:#6b7280;margin-right:6px;font-weight:400}
.secure{font-size:12px;color:#9aa0a6;text-align:center;margin-top:18px}
.hidden{display:none}
</style></head><body>
<div class="topbar"><div class="topbar-in"><div class="shop">__SHOP_NAME__</div><div class="bag">🛍️</div></div></div>
<div class="wrap">

<div class="col-form">
<div class="head-row"><h2>Contact</h2></div>
<div class="ff"><input id="email" type="email" placeholder=" "/><label>Adresse e-mail</label></div>

<h2>Livraison</h2>
<div class="ff sel"><select id="country">${COUNTRY_OPTIONS}</select><label>Pays / region</label></div>
<div class="row2"><div class="ff"><input id="first_name" placeholder=" "/><label>Prenom</label></div><div class="ff"><input id="last_name" placeholder=" "/><label>Nom</label></div></div>
<div class="ff"><input id="address" placeholder=" "/><label>Adresse (optionnel)</label></div>
<div class="row2"><div class="ff"><input id="zip" placeholder=" "/><label>Code postal (optionnel)</label></div><div class="ff"><input id="city" placeholder=" "/><label>Ville (optionnel)</label></div></div>
<div class="ff"><input id="phone" placeholder=" "/><label>Telephone (optionnel)</label></div>

<h2>Mode d'expedition</h2>
<div class="ship"><span class="dot"></span><span>__SHIPPING__</span><span class="free">GRATUIT</span></div>

<h2>Paiement</h2>
<div class="muted">Toutes les transactions sont securisees et chiffrees.</div>
<div class="paybox">
<div class="paybox-head"><span class="dot"></span><span>Carte de credit</span><span class="brands"><span class="brand b-visa">VISA</span><span class="brand b-mc">MC</span><span class="brand b-amex">AMEX</span></span></div>
<div class="paybox-body">
<div id="card-ph">Chargement du paiement securise…</div>
<div id="card-container"></div>
<div class="ff" id="holder-wrap" style="margin-top:12px"><input id="card_holder" placeholder=" "/><label>Nom sur la carte</label></div>
</div>
</div>
<div id="error" class="error"></div>
<button id="pay-btn" class="btn" disabled><span id="pay-btn-text">Payer maintenant</span></button>
<div class="secure">🔒 Toutes les transactions sont securisees · PCI DSS</div>
</div>

<div class="col-sum">
<div id="sum-items"></div>
<div class="sumline"><span>Sous-total</span><span id="sum-sub">—</span></div>
<div class="sumline"><span>Expedition</span><span>GRATUIT</span></div>
<div class="sumtotal"><span>Total</span><span><span class="cur" id="sum-cur"></span><span id="sum-total">—</span></span></div>
</div>

</div>
<script src="/config.js"></script>
<script>
(function(){
var qs=new URLSearchParams(location.search);
var order={amount:qs.get('amount'),currency:qs.get('currency'),order_ref:qs.get('order_ref'),sig:qs.get('sig'),shop:qs.get('shop')};
var DCUR='EUR';
var disp=order.amount?(order.amount+' '+DCUR):'—';
document.getElementById('sum-sub').textContent=disp;
document.getElementById('sum-cur').textContent=DCUR;
document.getElementById('sum-total').textContent=order.amount||'—';
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function renderItems(){
var html='';
var raw=qs.get('items');
if(raw){try{var arr=JSON.parse(decodeURIComponent(escape(atob(raw))));arr.forEach(function(it){
var img=it.img?('<img src="'+esc(it.img)+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px"/>'):'🛍️';
html+='<div class="sum-item"><div class="sum-thumb">'+img+'<span class="sum-qty">'+(it.qty||1)+'</span></div><div><div class="nm">'+esc(it.title)+'</div>'+(it.variant?'<div class="sub">'+esc(it.variant)+'</div>':'')+'</div><div class="pr">'+esc(it.price)+' '+DCUR+'</div></div>';
});}catch(e){}}
if(!html){html='<div class="sum-item"><div class="sum-thumb">🛍️<span class="sum-qty">1</span></div><div><div class="nm">Commande __SHOP_NAME__</div><div class="sub">Paiement securise</div></div><div class="pr">'+disp+'</div></div>';}
document.getElementById('sum-items').innerHTML=html;
}
renderItems();

var sess=null,ready=false,cardReady=false;
function v(id){return document.getElementById(id).value.trim();}
function showError(m){document.getElementById('error').textContent=m;}
function setPay(on){var b=document.getElementById('pay-btn');b.disabled=on;document.getElementById('pay-btn-text').textContent=on?'Traitement…':'Payer maintenant';}

function loadSdk(){return new Promise(function(res,rej){if(window.Checkout)return res();var s=document.createElement('script');s.src=window.CHECKOUT_CONFIG.sdkUrl;s.onload=res;s.onerror=function(){rej(new Error('Impossible de charger le module de paiement.'));};document.head.appendChild(s);});}

// 1) Au CHARGEMENT : on affiche le module carte tout de suite (team_id/app_id du marchand).
fetch('/api/sdk').then(function(r){return r.json();}).then(function(d){
if(d.status!=='success')throw new Error(d.message||'Module indisponible');
return loadSdk().then(function(){
Checkout.init({containerId:'card-container',team_id:d.team_id,app_id:d.app_id,
onReady:function(){cardReady=true;document.getElementById('pay-btn').disabled=false;document.getElementById('card-ph').style.display='none';},
onCard:onCard,
onError:function(e){setPay(false);showError(e.message||'Erreur carte');}});
});
}).catch(function(e){document.getElementById('card-ph').textContent='Paiement momentanement indisponible. Reessayez.';showError(e.message||'');});

// 3) Une fois la carte tokenisee : on finalise avec la session reelle.
function onCard(cd){
fetch('/api/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction_unique_id:sess.transaction_unique_id,session_token:sess.session_token,card_token:cd.cardToken,encrypted_cvv:cd.encryptedCvv,bin:cd.bin,last4:cd.last4,card_holder:v('card_holder'),card_exp_month:cd.expMonth,card_exp_year:cd.expYear})})
.then(function(r){return r.json();}).then(function(d){if(d.acs_url){window.location.href=d.acs_url;return;}window.location.href='/return?txn='+encodeURIComponent(sess.transaction_unique_id)+(order.shop?('&shop='+encodeURIComponent(order.shop)):'');})
.catch(function(e){setPay(false);showError(e.message||'Erreur de paiement');});
}

// 2) Au clic PAYER : on valide les infos, on cree la session reelle, puis on tokenise la carte.
document.getElementById('pay-btn').addEventListener('click',function(){
var em=v('email'),fn=v('first_name'),ln=v('last_name'),co=v('country');
if(!em||em.indexOf('@')<1){showError('Adresse e-mail invalide.');return;}
if(!fn||!ln){showError('Merci d\\'indiquer prenom et nom.');return;}
if(!co){showError('Merci de choisir un pays.');return;}
if(!cardReady){showError('Le module de paiement charge encore, patientez.');return;}
if(!v('card_holder')){showError('Le nom sur la carte est requis.');return;}
showError('');setPay(true);
fetch('/api/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:order.amount,currency:order.currency,order_ref:order.order_ref,sig:order.sig,shop:order.shop,customer:{first_name:fn,last_name:ln,email:em,country:co,address:v('address'),city:v('city'),zip:v('zip'),phone:v('phone')}})})
.then(function(r){return r.json();}).then(function(d){
if(d.status!=='success')throw new Error(d.message||'Paiement refuse');
sess=d;Checkout.submit('card-container');
}).catch(function(e){setPay(false);showError(e.message||'Erreur');});
});

if(!order.amount||!order.sig){showError('Lien de paiement invalide.');document.getElementById('pay-btn').disabled=true;}
})();
</script></body></html>`;

const RETURN_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Statut - __SHOP_NAME__</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','27340245992304204');fbq('track','PageView');
</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=27340245992304204&ev=PageView&noscript=1"/></noscript>
<style>
body{font-family:'Inter',system-ui,sans-serif;background:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#1a1a1a;margin:0;padding:20px}
.card{background:#fff;border:1px solid #e6e6e6;border-radius:14px;padding:40px;max-width:460px;width:100%;text-align:center;box-sizing:border-box}
h1{font-size:20px;margin:0 0 10px}p{color:#6b7280;font-size:14px;margin:6px 0}
.ok{color:#108043}.ko{color:#d82c0d}.pending{color:#2563eb}
.spinner{width:30px;height:30px;border:3px solid #e6e6e6;border-top-color:#2563eb;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 18px}
@keyframes spin{to{transform:rotate(360deg)}}
.offer{display:none;margin-top:22px;border:2px dashed #2563eb;border-radius:14px;padding:22px;background:#f5f8ff;text-align:left}
.offer .tag{display:inline-block;background:#2563eb;color:#fff;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;letter-spacing:.4px}
.offer h2{font-size:18px;margin:12px 0 6px}
.offer .price{font-size:26px;font-weight:700;color:#1a1a1a}
.offer .price s{font-size:16px;color:#9aa1ab;font-weight:500;margin-left:8px}
.offer .save{display:inline-block;background:#e7f6ec;color:#108043;font-weight:600;font-size:13px;padding:3px 10px;border-radius:6px;margin-top:6px}
.offer .sub{color:#6b7280;font-size:13px;margin:10px 0 16px}
.btn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:15px;border-radius:10px;font-weight:600;font-size:15px;border:none;cursor:pointer;margin-top:10px}
.btn-yes{background:#2563eb;color:#fff}
.btn-no{background:transparent;color:#6b7280;text-decoration:underline;font-weight:500;font-size:13px;padding:8px}
.btn[disabled]{opacity:.6;cursor:default}
</style></head><body>
<div class="card">
  <div class="spinner" id="spinner"></div>
  <h1 id="title">Verification du paiement…</h1>
  <p id="msg">Merci de patienter.</p>
  <div class="offer" id="offer">
    <span class="tag">OFFRE UNIQUE — RIEN QUE POUR VOUS</span>
    <h2>Ajoutez un 2ᵉ matelas Coziya 🛏️</h2>
    <div class="price"><span id="up-price">39,99€</span> <s id="up-ref">69,99€</s></div>
    <span class="save" id="up-save">Économisez 30€</span>
    <p class="sub">Cette offre n'apparaît qu'ici et disparaît si vous quittez la page.</p>
    <button class="btn btn-yes" id="up-yes">✅ Oui, j'en profite</button>
    <button class="btn btn-no" id="up-no">Non merci, continuer</button>
  </div>
</div>
<script>
(function(){
var txn=new URLSearchParams(location.search).get('txn');
var title=document.getElementById('title'),msg=document.getElementById('msg'),spinner=document.getElementById('spinner'),offer=document.getElementById('offer'),tries=0;
function fmt(n){return (Number(n).toFixed(2)).replace('.',',')+'€';}
function done(t,m,cls){spinner.style.display='none';offer.style.display='none';title.textContent=t;title.className=cls;msg.textContent=m;}
function showUpsell(d){
  spinner.style.display='none';
  title.textContent='Paiement réussi ✅';title.className='ok';
  msg.textContent='Votre commande est confirmée. Merci !';
  document.getElementById('up-price').textContent=fmt(d.upsellAmount);
  document.getElementById('up-ref').textContent=fmt(d.upsellRef);
  document.getElementById('up-save').textContent='Économisez '+fmt(d.upsellSave);
  offer.style.display='block';
  document.getElementById('up-no').onclick=function(){done('Merci pour votre commande !','Votre paiement est confirmé.','ok');};
  document.getElementById('up-yes').onclick=function(){
    var y=document.getElementById('up-yes');y.disabled=true;y.textContent='Traitement…';
    fetch('/api/upsell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({txn:txn})})
    .then(function(r){return r.json();}).then(function(rr){
      if(rr.status==='success'){try{if(window.fbq)fbq('track','Purchase',{value:Number(d.upsellAmount)||0,currency:d.currency||'EUR'});}catch(e){}
        done('C\\'est ajouté ! 🎉','Votre 2ᵉ matelas a été ajouté à votre commande. Merci !','ok');}
      else{y.disabled=false;y.textContent='✅ Oui, j\\'en profite';msg.textContent='Offre indisponible pour le moment.';}
    }).catch(function(){y.disabled=false;y.textContent='✅ Oui, j\\'en profite';msg.textContent='Une erreur est survenue, réessayez.';});
  };
}
function poll(){if(!txn){return done('Reference manquante','Impossible de retrouver la transaction.','ko');}
fetch('/api/status?txn='+encodeURIComponent(txn)).then(function(r){return r.json();}).then(function(d){
var s=(d.status||'').toLowerCase();
if(['success','approved','completed','paid'].includes(s)){try{if(window.fbq)fbq('track','Purchase',{value:Number(d.amount)||0,currency:d.currency||'EUR'});}catch(e){}if(d.upsell){return showUpsell(d);}return done('Paiement réussi','Votre commande est confirmée. Merci !','ok');}
if(['declined','failed','error','rejected'].includes(s))return done('Paiement refusé','La transaction n a pas abouti.','ko');
tries++;if(tries>20)return done('En cours de traitement','Vous recevrez une confirmation par email.','pending');
setTimeout(poll,2000);}).catch(function(){setTimeout(poll,2000);});}
poll();
})();
</script></body></html>`;
