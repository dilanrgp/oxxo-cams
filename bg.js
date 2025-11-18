// URL del API de configuración de cámaras
let CONFIG_API_URL = null;

// Lee config.json del paquete de la extensión y saca configApiUrl
async function loadConfigApiUrl() {
  try {
    const url = chrome.runtime.getURL('config.json');
    const resp = await fetch(url);

    if (!resp.ok) {
      console.error(
        'bg.js: error al cargar config.json para CONFIG_API_URL:',
        resp.status
      );
      return;
    }

    const data = await resp.json();

    if (data && typeof data.configapiurl === 'string') {
      CONFIG_API_URL = data.configapiurl;
      console.log('bg.js: CONFIG_API_URL cargada desde config.json:', CONFIG_API_URL);
    } else {
      console.warn(
        'bg.js: configapiurl no definida en config.json; no se puede llamar al API de cámara'
      );
    }
  } catch (e) {
    console.error('bg.js: excepción al leer config.json para CONFIG_API_URL:', e);
  }
}


// Secreto para calcular el keyhash (igual que en getTimestampAndKeyhash de script.js)
const API_SECRET = 'ALRIDKJCS1SYADSKJDFS';

// =========================
// Helpers
// =========================

// Calcula timestamp + keyhash = SHA256(timestamp + secret)
async function getTimestampAndKeyhashForConfig() {
  const ts = Date.now(); // milisegundos
  const key = String(ts) + API_SECRET;

  if (!crypto || !crypto.subtle) {
    console.error('bg.js: Web Crypto API no disponible, no se puede calcular keyhash');
    return { ts, keyhash: '' };
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const keyhash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return { ts, keyhash };
}

// Guarda en storage que la cámara está inactiva
async function setCameraInactive() {
  if (!chrome.storage || !chrome.storage.local) return;
  await chrome.storage.local.set({
    cameraConfigStatus: false,
    cameraConfig: null
  });
}

// Guarda en storage la config calculada desde el API
async function setCameraConfigFromApiData(data) {
  if (!chrome.storage || !chrome.storage.local) return;

  // status: 1 = activa, otro = inactiva
  const active = data && (data.status === 1 || data.status === true);
  if (!active) {
    console.log('bg.js: status de cámara es inactivo en el API');
    await setCameraInactive();
    return;
  }

  // face_timeout en segundos
  const faceRetentionSeconds =
    typeof data.face_timeout === 'number' ? data.face_timeout : undefined;

  // threshold de matching
  const faceMatchThreshold =
    typeof data.face_threshold === 'number' ? data.face_threshold : undefined;

  // IDs
  const idcamera = data.idcamera;
  const idsite = typeof data.idsite !== 'undefined'
    ? data.idsite
    : (data.site && data.site.idsite);

  const customerid = data.site && typeof data.site.idcustomer !== 'undefined'
    ? data.site.idcustomer
    : (data.customer && data.customer.idcustomer);

  const email = typeof data.email === 'string' ? data.email : null;

  // Área de detección
  const detectArea =
    typeof data.section_start_x === 'number' &&
      typeof data.section_start_y === 'number' &&
      typeof data.section_width === 'number' &&
      typeof data.section_height === 'number'
      ? {
        enabled: true,
        x: data.section_start_x,
        y: data.section_start_y,
        width: data.section_width,
        height: data.section_height
      }
      : null;

  // Powers corresponde al schedule
  let schedule = null;
  if (Array.isArray(data.powers) && data.powers.length > 0) {
    // Asumimos que cada elemento ya tiene weekday, time_on, time_off
    schedule = data.powers
      .map(p => ({
        weekday: p.weekday,
        time_on: p.time_on,
        time_off: p.time_off
      }))
      .filter(p =>
        typeof p.weekday === 'number' &&
        typeof p.time_on === 'string' &&
        typeof p.time_off === 'string'
      );

    if (!schedule.length) {
      schedule = null;
    }
  }

  const cameraConfig = {
    faceRetentionSeconds,
    faceMatchThreshold,
    customerid,
    idsite,
    idcamera,
    email,
    detectArea,
    schedule
  };

  await chrome.storage.local.set({
    cameraConfigStatus: true,
    cameraConfig
  });

  console.log('bg.js: cameraConfig guardada en storage.local:', cameraConfig);
}

// =========================
// Lógica principal: leer Asset ID, sacar email, llamar API config
// =========================

async function updateCameraConfigFromAssetId() {
  if (!chrome.storage || !chrome.storage.local) {
    console.warn('bg.js: chrome.storage.local no disponible');
    return;
  }

  // 🔹 Asegurarnos de que CONFIG_API_URL viene de config.json
  if (!CONFIG_API_URL) {
    await loadConfigApiUrl();
  }

  if (!CONFIG_API_URL) {
    console.error(
      'bg.js: CONFIG_API_URL sigue sin valor tras leer config.json; marcando cámara inactiva'
    );
    await setCameraInactive();
    return;
  }

  let assetId = null;

  // 1. Obtener Asset ID del dispositivo (solo en dispositivos gestionados)
  if (
    chrome.enterprise &&
    chrome.enterprise.deviceAttributes &&
    chrome.enterprise.deviceAttributes.getDeviceAssetId
  ) {
    assetId = await new Promise(resolve => {
      try {
        chrome.enterprise.deviceAttributes.getDeviceAssetId(id => {
          if (chrome.runtime.lastError) {
            console.log(
              'bg.js: error al obtener deviceAssetId:',
              chrome.runtime.lastError.message
            );
            resolve(null);
          } else {
            resolve(id || null);
          }
        });
      } catch (e) {
        console.error('bg.js: excepción en getDeviceAssetId:', e);
        resolve(null);
      }
    });
  } else {
    console.log('bg.js: enterprise.deviceAttributes no disponible');
    assetId = `LadorianCams-laboratorio@ladorian.com-Test Oxxo Oficina`
  }

  if (!assetId || typeof assetId !== 'string') {
    console.log('bg.js: AssetId vacío o inválido, marcando cámara inactiva');
    await setCameraInactive();
    return;
  }

  // Formato esperado:
  // "LadorianCams-laboratorio@ladorian.com-Test Oxxo Oficina"
  // => ["LadorianCams", "laboratorio@ladorian.com", "Test Oxxo Oficina"]
  const parts = assetId.split('-');
  const prefix = (parts[0] || '').trim();
  const emailCandidate = (parts[1] || '').trim();

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (prefix !== 'LadorianCams' || !emailRegex.test(emailCandidate)) {
    console.log(
      'bg.js: AssetId no cumple formato "LadorianCams-email-text":',
      assetId
    );
    await setCameraInactive();
    return;
  }

  const email = emailCandidate;
  console.log('bg.js: email obtenido del AssetId:', email);

  // 2. Llamar al API de configuración con ese email
  try {
    const { ts, keyhash } = await getTimestampAndKeyhashForConfig();
    const url =
      `${CONFIG_API_URL}` +
      `?email=${encodeURIComponent(email)}` +
      `&timestamp=${ts}` +
      `&keyhash=${keyhash}`;

    const resp = await fetch(url, { method: 'GET' });

    if (!resp.ok) {
      console.error('bg.js: error HTTP al obtener config de cámara:', resp.status);
      await setCameraInactive();
      return;
    }

    const json = await resp.json();

    if (!json || json.success !== true || !json.data) {
      console.log('bg.js: respuesta del API sin success/data válidos:', json);
      await setCameraInactive();
      return;
    }

    await setCameraConfigFromApiData(json.data);
  } catch (err) {
    console.error('bg.js: excepción al obtener config de cámara:', err);
    await setCameraInactive();
  }
}

// =========================
// Abrir la app al arrancar / instalar
// =========================

async function openApp() {
  // Primero cargamos la URL del API de config desde config.json
  await loadConfigApiUrl();

  // Luego ya actualizamos la config de cámara (esto por si se llama desde otros sitios)
  await updateCameraConfigFromAssetId();

  const url = chrome.runtime.getURL('index.html');
  await chrome.windows.create({ url, state: 'maximized', focused: true });
}

chrome.runtime.onStartup.addListener(openApp);
chrome.runtime.onInstalled.addListener(openApp);

// =========================
// Envío de eventos de caras al API (ya lo tenías)
// =========================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'SEND_FACE_EVENT') {
    const { url, payload } = message;

    (async () => {
      try {
        const response = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const text = await response.text().catch(() => '');

        if (!response.ok) {
          console.error(
            'bg.js: error al enviar evento de cara:',
            response.status,
            text
          );
          sendResponse({ ok: false, status: response.status, body: text });
        } else {
          console.log('bg.js: evento de cara enviado OK');
          sendResponse({ ok: true });
        }
      } catch (err) {
        console.error('bg.js: excepción al enviar evento de cara:', err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();

    // Responder async
    return true;
  }

  return false;
});
