import express from "express";
import crypto from "node:crypto";

const {
  MERCHANT_ACCOUNT,
  MERCHANT_PASSWORD,
  QDR_API_BASE = "https://api.qdr6wy.im",
  QDR_SDK_URL = "https://api.qdr6wy.im/js/checkout.js",
  PUBLIC_BASE_URL = "http://localhost:3000",
  CHECKOUT_SIGNING_SECRET = "dev-secret",
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
  res.type("html").send(CHECKOUT_HTML);
});

app.get("/return", (_req, res) => res.type("html").send(RETURN_HTML));

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

const CHECKOUT_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Paiement securise</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.checkout-card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);width:100%;max-width:440px;overflow:hidden}
.checkout-header{padding:28px 32px 24px;border-bottom:1px solid #f0f0f0}
.brand{font-size:13px;font-weight:600;color:#6366f1;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px}
.checkout-header h1{font-size:20px;font-weight:600;color:#111}
.amount{font-size:14px;color:#111;margin-top:6px;font-weight:600}
.checkout-body{padding:28px 32px 32px}
.field{margin-bottom:16px}
.row2{display:flex;gap:12px}
.row2 .field{flex:1}
.field label,.field-card label{display:block;font-size:12px;font-weight:500;color:#6b7280;letter-spacing:.03em;text-transform:uppercase;margin-bottom:6px}
.field input{width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;color:#111;background:#fff;outline:none}
.field input:focus{border-color:#6366f1}
.field-card{margin-bottom:24px}
#card-container{min-height:44px}
#card-container iframe{display:block;width:100%;border:none;min-height:200px}
.error{font-size:13px;color:#ef4444;min-height:20px;margin-bottom:12px}
.btn{width:100%;padding:13px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
.btn:disabled{opacity:.5;cursor:default}
.secure-note{display:flex;align-items:center;justify-content:center;gap:5px;font-size:12px;color:#9ca3af;margin-top:16px}
</style></head><body>
<div class="checkout-card">
<div class="checkout-header"><div class="brand">My Brand</div><h1>Paiement securise</h1><div class="amount" id="amount-display">—</div></div>
<div class="checkout-body">

<div id="step-info">
<div class="row2">
<div class="field"><label>Prenom</label><input id="first_name" type="text" placeholder="Prenom"/></div>
<div class="field"><label>Nom</label><input id="last_name" type="text" placeholder="Nom"/></div>
</div>
<div class="field"><label>Email</label><input id="email" type="email" placeholder="email@exemple.com"/></div>
<div class="field"><label>Pays</label><input id="country" type="text" placeholder="France"/></div>
<div id="error1" class="error"></div>
<button id="continue-btn" class="btn"><span id="continue-text">Continuer vers le paiement</span></button>
</div>

<div id="step-card" style="display:none">
<div class="field"><label>Nom du titulaire</label><input id="card_holder" type="text" placeholder="Nom sur la carte"/></div>
<div class="field-card"><label>Details de la carte</label><div id="card-container"></div></div>
<div id="error" class="error"></div>
<button id="pay-btn" class="btn" disabled><span id="pay-btn-text">Payer</span></button>
</div>

<div class="secure-note">Securise · PCI DSS</div>
</div></div>
<script src="/config.js"></script>
<script>
(function(){
var qs=new URLSearchParams(location.search);
var order={amount:qs.get('amount'),currency:qs.get('currency'),order_ref:qs.get('order_ref'),sig:qs.get('sig')};
document.getElementById('amount-display').textContent=order.amount?(order.amount+' '+(order.currency||'')):'—';
var state={};
function err1(m){document.getElementById('error1').textContent=m;}
function showError(m){document.getElementById('error').textContent=m;}
function setPay(on){var b=document.getElementById('pay-btn');b.disabled=on;document.getElementById('pay-btn-text').textContent=on?'Traitement…':'Payer';}

function loadSdk(){return new Promise(function(res,rej){var s=document.createElement('script');s.src=window.CHECKOUT_CONFIG.sdkUrl;s.onload=res;s.onerror=function(){rej(new Error('Impossible de charger le SDK de paiement.'));};document.head.appendChild(s);});}

function initSdk(){Checkout.init({containerId:'card-container',team_id:state.team_id,app_id:state.app_id,onReady:function(){document.getElementById('pay-btn').disabled=false;},onCard:onCard,onError:function(e){setPay(false);showError(e.message||'Erreur carte');}});}

function onCard(cd){showError('');setPay(true);fetch('/api/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction_unique_id:state.transaction_unique_id,session_token:state.session_token,card_token:cd.cardToken,encrypted_cvv:cd.encryptedCvv,bin:cd.bin,last4:cd.last4,card_holder:document.getElementById('card_holder').value.trim(),card_exp_month:cd.expMonth,card_exp_year:cd.expYear})}).then(function(r){return r.json();}).then(function(d){if(d.acs_url){window.location.href=d.acs_url;return;}window.location.href='/return?txn='+encodeURIComponent(state.transaction_unique_id);}).catch(function(e){setPay(false);showError(e.message||'Erreur de paiement');});}

document.getElementById('continue-btn').addEventListener('click',function(){
var fn=document.getElementById('first_name').value.trim();
var ln=document.getElementById('last_name').value.trim();
var em=document.getElementById('email').value.trim();
var co=document.getElementById('country').value.trim();
if(!fn||!ln||!em||!co){err1('Merci de remplir prenom, nom, email et pays.');return;}
if(em.indexOf('@')<1){err1('Email invalide.');return;}
err1('');
var btn=document.getElementById('continue-btn');btn.disabled=true;document.getElementById('continue-text').textContent='Chargement…';
fetch('/api/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:order.amount,currency:order.currency,order_ref:order.order_ref,sig:order.sig,customer:{first_name:fn,last_name:ln,email:em,country:co}})})
.then(function(r){return r.json();}).then(function(d){
if(d.status!=='success'){throw new Error(d.message||'Init refuse');}
state=d;
document.getElementById('step-info').style.display='none';
document.getElementById('step-card').style.display='block';
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
<title>Statut du paiement</title>
<style>
body{font-family:system-ui,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;padding:40px;max-width:420px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:20px;margin-bottom:10px}p{color:#6b7280;font-size:14px}
.ok{color:#16a34a}.ko{color:#ef4444}.pending{color:#6366f1}
.spinner{width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#6366f1;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 16px}
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
if(['success','approved','completed','paid'].includes(s))return done('Paiement reussi','Votre commande est confirmee.','ok');
if(['declined','failed','error','rejected'].includes(s))return done('Paiement refuse','La transaction n a pas abouti.','ko');
tries++;if(tries>20)return done('En cours de traitement','Vous recevrez une confirmation par email.','pending');
setTimeout(poll,2000);}).catch(function(){setTimeout(poll,2000);});}
poll();
})();
</script></body></html>`;
