import express from "express";
import crypto from "node:crypto";

const {
  MERCHANT_ACCOUNT,
  MERCHANT_PASSWORD,
  QDR_API_BASE = "https://api.qdr6wy.im",
  QDR_SDK_URL = "https://api.qdr6wy.im/js/checkout.js",
  PUBLIC_BASE_URL = "http://localhost:3000",
  CHECKOUT_SIGNING_SECRET = "dev-secret",
  SHOP_NAME = "My Store 2",
  PORT = 3000,
  MOCK_MODE = "false",
} = process.env;

const MOCK = String(MOCK_MODE).toLowerCase() === "true";

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
    return { status: "pending", code: 0, message: "3DS required (mock)",
      acs_url: `${PUBLIC_BASE_URL}/return?status=success&mock3ds=1` };
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
  res.redirect(`/checkout?amount=${encodeURIComponent(amount)}&currency=${encodeURIComponent(currency)}&order_ref=${encodeURIComponent(order_ref)}&sig=${sig}`);
});

app.get("/checkout", (req, res) => {
  if (!verifySignature(req.query)) return res.status(400).send("Lien de paiement invalide ou expire.");
  res.type("html").send(CHECKOUT_HTML.replace(/__SHOP_NAME__/g, SHOP_NAME));
});

app.get("/return", (_req, res) => res.type("html").send(RETURN_HTML.replace(/__SHOP_NAME__/g, SHOP_NAME)));

app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(
    `window.CHECKOUT_CONFIG = ${JSON.stringify({ sdkUrl: QDR_SDK_URL, apiBase: PUBLIC_BASE_URL })};`
  );
});

app.post("/api/init", async (req, res) => {
  try {
    const { amount, currency, order_ref, sig, customer } = req.body || {};
    if (!verifySignature({ amount, currency, order_ref, sig }))
      return res.status(400).json({ status: "error", message: "Signature montant invalide." });
    const transaction_unique_id = crypto.randomUUID();
    const c = customer || {};
    const initBody = {
      merchant_account: MERCHANT_ACCOUNT, merchant_password: MERCHANT_PASSWORD,
      transaction_unique_id, amount: Number(amount), currency,
      first_name: c.first_name || "", last_name: c.last_name || "", address: c.address || "",
      city: c.city || "", state: c.state || "", zip: c.zip || "", country: c.country || "",
      user_phone: c.phone || "", user_email: c.email || "",
      user_ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
      callback_url: `${PUBLIC_BASE_URL}/api/webhook`,
      redirect_url: `${PUBLIC_BASE_URL}/return?txn=${transaction_unique_id}`,
    };
    const data = await callQdr("/v2/cc/sale3d/init", initBody);
    if (data.status !== "success" || !data.payload)
      return res.status(502).json({ status: "error", message: data.message || "init a echoue", raw: data });
    transactions.set(transaction_unique_id, {
      orderRef: order_ref, amount: Number(amount), currency, status: "initiated",
      sessionToken: data.payload.session_token,
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
    if (txn) { txn.status = payload.status || txn.status; transactions.set(id, txn); }
    res.json({ received: true });
  } catch (e) { console.error("webhook error", e); res.status(200).json({ received: true }); }
});

app.get("/api/status", (req, res) => {
  const txn = transactions.get(req.query.txn);
  if (!txn) return res.status(404).json({ status: "unknown" });
  res.json({ status: txn.status, amount: txn.amount, currency: txn.currency });
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
<title>__SHOP_NAME__ — Paiement</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#fff;color:#1a1a1a}
.wrap{display:flex;min-height:100vh;flex-wrap:wrap}
.left{flex:1 1 520px;display:flex;justify-content:flex-end;border-right:1px solid #e6e6e6}
.right{flex:1 1 420px;background:#fafafa;border-left:1px solid #e6e6e6}
.left-inner{width:100%;max-width:520px;padding:40px 48px}
.right-inner{width:100%;max-width:460px;padding:40px 48px}
.brand{font-size:24px;font-weight:700;margin-bottom:28px}
h2{font-size:17px;font-weight:600;margin:24px 0 12px}
.row2{display:flex;gap:12px}.row2>div{flex:1}
.fld{margin-bottom:12px;position:relative}
label{display:block;font-size:12px;color:#6b7280;margin-bottom:6px}
input,select{width:100%;padding:12px 13px;border:1px solid #c9cccf;border-radius:6px;font-size:15px;font-family:inherit;color:#1a1a1a;background:#fff;outline:none}
input:focus,select:focus{border-color:#1a73e8;box-shadow:0 0 0 1px #1a73e8}
input::placeholder{color:#9aa0a6}
#card-container{min-height:46px}
#card-container iframe{display:block;width:100%;border:none;min-height:210px}
.pay-section{margin-top:8px}
.muted{font-size:13px;color:#6b7280;margin-bottom:12px}
.error{font-size:13px;color:#d82c0d;min-height:18px;margin:8px 0}
.btn{width:100%;padding:15px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;font-family:inherit;cursor:pointer;margin-top:8px}
.btn:disabled{opacity:.5;cursor:default}
.summary-item{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.thumb{width:56px;height:56px;border-radius:8px;background:#ececec;border:1px solid #e0e0e0;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#9aa0a6}
.summary-item .nm{font-size:14px;font-weight:500}
.summary-item .pr{margin-left:auto;font-size:14px;font-weight:500}
.sumline{display:flex;justify-content:space-between;font-size:14px;color:#454545;margin:8px 0}
.sumtotal{display:flex;justify-content:space-between;align-items:baseline;font-size:20px;font-weight:600;border-top:1px solid #e0e0e0;margin-top:14px;padding-top:14px}
.sumtotal .cur{font-size:12px;color:#6b7280;margin-right:6px;font-weight:400}
.secure{font-size:12px;color:#9aa0a6;text-align:center;margin-top:18px}
.hidden{display:none}
@media(max-width:850px){.left,.right{flex:1 1 100%;border:none}.right{order:-1;border-bottom:1px solid #e6e6e6}.left-inner,.right-inner{padding:28px 22px;max-width:100%}}
</style></head><body>
<div class="wrap">
<div class="right"><div class="right-inner">
<div class="summary-item">
<div class="thumb">🛍️</div>
<div class="nm">Commande __SHOP_NAME__<div style="font-size:12px;color:#6b7280;font-weight:400">Paiement securise</div></div>
<div class="pr" id="sum-price">—</div>
</div>
<div class="sumline"><span>Sous-total</span><span id="sum-sub">—</span></div>
<div class="sumline"><span>Livraison</span><span>Calculee a l'etape suivante</span></div>
<div class="sumtotal"><span>Total</span><span><span class="cur" id="sum-cur"></span><span id="sum-total">—</span></span></div>
</div></div>

<div class="left"><div class="left-inner">
<div class="brand">__SHOP_NAME__</div>

<div id="step-info">
<h2>Coordonnees</h2>
<div class="fld"><input id="email" type="email" placeholder="Adresse e-mail"/></div>
<h2>Livraison</h2>
<div class="fld"><label>Pays / region</label><select id="country">${COUNTRY_OPTIONS}</select></div>
<div class="row2"><div class="fld"><input id="first_name" type="text" placeholder="Prenom"/></div><div class="fld"><input id="last_name" type="text" placeholder="Nom"/></div></div>
<div class="fld"><input id="address" type="text" placeholder="Adresse (optionnel)"/></div>
<div class="row2"><div class="fld"><input id="zip" type="text" placeholder="Code postal (optionnel)"/></div><div class="fld"><input id="city" type="text" placeholder="Ville (optionnel)"/></div></div>
<div class="fld"><input id="phone" type="text" placeholder="Telephone (optionnel)"/></div>
<div id="error1" class="error"></div>
<button id="continue-btn" class="btn"><span id="continue-text">Continuer vers le paiement</span></button>
</div>

<div id="step-card" class="hidden pay-section">
<h2>Paiement</h2>
<div class="muted">Toutes les transactions sont securisees et chiffrees.</div>
<div class="fld"><input id="card_holder" type="text" placeholder="Nom du titulaire de la carte"/></div>
<div class="fld"><div id="card-container"></div></div>
<div id="error" class="error"></div>
<button id="pay-btn" class="btn" disabled><span id="pay-btn-text">Payer maintenant</span></button>
</div>

<div class="secure">🔒 Securise · PCI DSS</div>
</div></div>
</div>
<script src="/config.js"></script>
<script>
(function(){
var qs=new URLSearchParams(location.search);
var order={amount:qs.get('amount'),currency:qs.get('currency'),order_ref:qs.get('order_ref'),sig:qs.get('sig')};
var disp=order.amount?(order.amount+' '+(order.currency||'')):'—';
document.getElementById('sum-price').textContent=disp;
document.getElementById('sum-sub').textContent=disp;
document.getElementById('sum-cur').textContent=order.currency||'';
document.getElementById('sum-total').textContent=order.amount||'—';
var state={};
function err1(m){document.getElementById('error1').textContent=m;}
function showError(m){document.getElementById('error').textContent=m;}
function setPay(on){var b=document.getElementById('pay-btn');b.disabled=on;document.getElementById('pay-btn-text').textContent=on?'Traitement…':'Payer maintenant';}

function loadSdk(){return new Promise(function(res,rej){var s=document.createElement('script');s.src=window.CHECKOUT_CONFIG.sdkUrl;s.onload=res;s.onerror=function(){rej(new Error('Impossible de charger le module de paiement.'));};document.head.appendChild(s);});}
function initSdk(){Checkout.init({containerId:'card-container',team_id:state.team_id,app_id:state.app_id,onReady:function(){document.getElementById('pay-btn').disabled=false;},onCard:onCard,onError:function(e){setPay(false);showError(e.message||'Erreur carte');}});}
function onCard(cd){showError('');setPay(true);fetch('/api/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction_unique_id:state.transaction_unique_id,session_token:state.session_token,card_token:cd.cardToken,encrypted_cvv:cd.encryptedCvv,bin:cd.bin,last4:cd.last4,card_holder:document.getElementById('card_holder').value.trim(),card_exp_month:cd.expMonth,card_exp_year:cd.expYear})}).then(function(r){return r.json();}).then(function(d){if(d.acs_url){window.location.href=d.acs_url;return;}window.location.href='/return?txn='+encodeURIComponent(state.transaction_unique_id);}).catch(function(e){setPay(false);showError(e.message||'Erreur de paiement');});}

document.getElementById('continue-btn').addEventListener('click',function(){
var v=function(id){return document.getElementById(id).value.trim();};
var fn=v('first_name'),ln=v('last_name'),em=v('email'),co=v('country');
if(!em||em.indexOf('@')<1){err1('Email invalide.');return;}
if(!fn||!ln){err1('Merci d\\'indiquer prenom et nom.');return;}
if(!co){err1('Merci de choisir un pays.');return;}
err1('');
var btn=document.getElementById('continue-btn');btn.disabled=true;document.getElementById('continue-text').textContent='Chargement…';
fetch('/api/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:order.amount,currency:order.currency,order_ref:order.order_ref,sig:order.sig,customer:{first_name:fn,last_name:ln,email:em,country:co,address:v('address'),city:v('city'),zip:v('zip'),phone:v('phone')}})})
.then(function(r){return r.json();}).then(function(d){
if(d.status!=='success'){throw new Error(d.message||'Init refuse');}
state=d;
document.getElementById('continue-btn').classList.add('hidden');
document.getElementById('step-card').classList.remove('hidden');
return loadSdk().then(initSdk);
}).catch(function(e){btn.disabled=false;document.getElementById('continue-text').textContent='Continuer vers le paiement';err1(e.message||'Erreur');});
});

document.getElementById('pay-btn').addEventListener('click',function(){
if(!document.getElementById('card_holder').value.trim()){showError('Le nom du titulaire est requis.');return;}
showError('');Checkout.submit('card-container');
});

if(!order.amount||!order.sig){err1('Lien de paiement invalide.');document.getElementById('continue-btn').disabled=true;}
})();
</script></body></html>`;

const RETURN_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>__SHOP_NAME__ — Statut</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
body{font-family:'Inter',system-ui,sans-serif;background:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#1a1a1a}
.card{background:#fff;border:1px solid #e6e6e6;border-radius:14px;padding:44px;max-width:440px;text-align:center}
h1{font-size:20px;margin-bottom:10px}p{color:#6b7280;font-size:14px}
.ok{color:#108043}.ko{color:#d82c0d}.pending{color:#1a73e8}
.spinner{width:30px;height:30px;border:3px solid #e6e6e6;border-top-color:#1a1a1a;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 18px}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<div class="card"><div class="spinner" id="spinner"></div><h1 id="title">Verification du paiement…</h1><p id="msg">Merci de patienter.</p></div>
<script>
(function(){
var txn=new URLSearchParams(location.search).get('txn');
var title=document.getElementById('title'),msg=document.getElementById('msg'),spinner=document.getElementById('spinner'),tries=0;
function done(t,m,cls){spinner.style.display='none';title.textContent=t;title.className=cls;msg.textContent=m;}
function poll(){if(!txn){return done('Reference manquante','Impossible de retrouver la transaction.','ko');}
fetch('/api/status?txn='+encodeURIComponent(txn)).then(function(r){return r.json();}).then(function(d){
var s=(d.status||'').toLowerCase();
if(['success','approved','completed','paid'].includes(s))return done('Paiement reussi','Votre commande est confirmee. Merci !','ok');
if(['declined','failed','error','rejected'].includes(s))return done('Paiement refuse','La transaction n a pas abouti.','ko');
tries++;if(tries>20)return done('En cours de traitement','Vous recevrez une confirmation par email.','pending');
setTimeout(poll,2000);}).catch(function(){setTimeout(poll,2000);});}
poll();
})();
</script></body></html>`;
