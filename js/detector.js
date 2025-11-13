(async function () {
  // CONFIGURACIÓN - Cambia esto según tu servidor
  // const WS_URL = 'wss://influxes.ladorianids.es:5000'; // localhost o tu IP
  const { WS_URL, OVERLAY } = await (async function getConfig() {
    const res = await fetch('/config.json', { cache: 'no-store' });
    const cfg = await res.json();
    // Si "overlay" no existe, por defecto true (se dibuja)
    return { WS_URL: cfg.WS_URL, OVERLAY: (typeof cfg.overlay === 'boolean') ? cfg.overlay : true };
  })(); // localhost o tu IP

  const FACE_CONFIDENCE_THRESHOLD = 0.8;
  const DUPLICATE_TIMEOUT = 10 * 1000; // pruebas: 10s (luego súbelo a 60–120s)
  const SIMILARITY_THRESHOLD = 0.15;     // antes 0.28
  const BBOX_CENTER_TOL = 0.03;     // antes 0.08
  const BBOX_SIZE_TOL = 0.08;     // antes 0.18
  const EMA_ALPHA = 0.25;
  const FACE_CHECK_INTERVAL = 500;
  const MIN_SEND_INTERVAL = 2000; // 2s
  const MAX_CACHE = 50;

  const seenFaces = new Map();

  const pending = new Map();          // caras candidatas
  const NEW_FACE_CONFIRM_MS = 600;    // ventana para confirmar

  let lastNumDetections = -1;
  let lastDetectReport = 0;
  const DETECT_REPORT_MIN_MS = 1200;

  function keyFromBBox(b) {
    // celda gruesa por centro y tamaño (normalizados 0..1)
    const cx = Math.round(b.cx * 20), cy = Math.round(b.cy * 20);
    const s = Math.round(Math.hypot(b.w, b.h) * 20);
    return `${cx}_${cy}_${s}`;
  }

  // Función para reportar estado al padre
  function report(msg) {
    try {
      parent.postMessage({ type: 'status', msg }, '*');
    } catch (e) {
      console.log(msg);
    }
  }

  // 1) Verificar que TensorFlow y BlazeFace están cargados
  if (typeof tf === 'undefined') {
    report('❌ TensorFlow.js no cargado');
    return;
  }

  if (typeof blazeface === 'undefined') {
    report('❌ BlazeFace no cargado');
    return;
  }

  // 2) Configurar backend y cargar modelo
  await tf.setBackend('webgl');
  await tf.ready();

  report('Cargando modelo...');

  // Determinar URL del modelo (funciona en extensión y local)
  const modelUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('models/blazeface/model.json')
    : new URL('../models/blazeface/model.json', location.href).toString();

  console.log('📦 Cargando modelo desde:', modelUrl);

  const model = await blazeface.load({
    modelUrl,
    maxFaces: 5,
    iouThreshold: 0.3,
    scoreThreshold: 0.85
  });

  report('✅ Modelo cargado. Esperando frames...');

  // 3) Canvas de trabajo
  let TARGET_W = 640, TARGET_H = 480;
  const c = document.createElement('canvas');
  c.width = TARGET_W;
  c.height = TARGET_H;
  const x = c.getContext('2d', { willReadFrequently: true });

  // 4) WebSocket para enviar frames
  let ws, backoff = 500;

  function openWS() {
    try {
      ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        backoff = 500;
        report('✅ WS conectado');
        console.log('✅ WebSocket conectado a', WS_URL);
      };

      ws.onclose = () => {
        console.log('⚠️ WebSocket desconectado, reintentando...');
        setTimeout(openWS, (backoff = Math.min(backoff * 2, 10000)));
      };

      ws.onerror = (e) => {
        console.error('❌ WS error:', e);
      };
    } catch (err) {
      console.error('❌ No se pudo crear WebSocket:', err);
      setTimeout(openWS, backoff);
    }
  }

  openWS();

  // 5) Utilidades de tracking (igual que tu código original)
  function getBBox(pred) {
    const [x1, y1] = pred.topLeft;
    const [x2, y2] = pred.bottomRight;
    const w = x2 - x1, h = y2 - y1;
    const cx = (x1 + x2) / 2 / TARGET_W;
    const cy = (y1 + y2) / 2 / TARGET_H;
    return { cx, cy, w: w / TARGET_W, h: h / TARGET_H };
  }

  function isSimilarBBox(b1, b2, centerTol = BBOX_CENTER_TOL, sizeTol = BBOX_SIZE_TOL) {
    const dcx = Math.abs(b1.cx - b2.cx);
    const dcy = Math.abs(b1.cy - b2.cy);
    const dw = Math.abs(b1.w - b2.w);
    const dh = Math.abs(b1.h - b2.h);
    return (dcx < centerTol && dcy < centerTol && dw < sizeTol && dh < sizeTol);
  }

  function adaptiveTols(b) {
    const diag = Math.max(0.02, Math.hypot(b.w, b.h)); // 0..1
    const k = Math.max(1, 0.06 / diag); // caras pequeñas ⇒ k>1
    return { center: BBOX_CENTER_TOL * k, size: BBOX_SIZE_TOL * k };
  }

  function emaFeatures(prev, next) {
    if (!prev || prev.length !== next.length) return next.slice();
    const out = new Array(next.length);
    for (let i = 0; i < next.length; i++) {
      out[i] = EMA_ALPHA * next[i] + (1 - EMA_ALPHA) * prev[i];
    }
    return out;
  }

  function extractFaceFeatures(pred) {
    const [x1, y1] = pred.topLeft;
    const [x2, y2] = pred.bottomRight;
    const w = x2 - x1, h = y2 - y1;
    const feats = [];

    if (pred.landmarks && pred.landmarks.length >= 6) {
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;

      for (const lm of pred.landmarks) {
        feats.push((lm[0] - cx) / w, (lm[1] - cy) / h);
      }
    }

    feats.push(w / h);
    return feats;
  }

  function isBigEnough(pred, minFrac = 0.03) {
    const [x1, y1] = pred.topLeft;
    const [x2, y2] = pred.bottomRight;
    const w = (x2 - x1) / TARGET_W;
    const h = (y2 - y1) / TARGET_H;
    return w >= minFrac && h >= minFrac;
  }

  function isTooBig(pred, maxFrac = 0.6) {
    const [x1, y1] = pred.topLeft;
    const [x2, y2] = pred.bottomRight;
    const w = (x2 - x1) / TARGET_W;
    const h = (y2 - y1) / TARGET_H;
    return w > maxFrac || h > maxFrac;
  }

  function isFaceAlreadySent(pred) {
    const now = Date.now();
    const features = extractFaceFeatures(pred);
    const bbox = getBBox(pred);
    let bestKey = null;
    let bestScore = Infinity;

    for (const [hash, data] of seenFaces.entries()) {
      if (now - data.timestamp > DUPLICATE_TIMEOUT) continue;

      // Chequeo rápido por bbox
      if (data.bbox) {
        const t = adaptiveTols(data.bbox);
        if (isSimilarBBox(bbox, data.bbox, t.center, t.size)) {
          data.timestamp = now;
          data.features = emaFeatures(data.features, features);
          data.bbox = bbox;
          return { known: true, key: hash };
        }
      }

      // Distancia por landmarks
      if (data.features && data.features.length === features.length) {
        let sum = 0;
        for (let i = 0; i < features.length; i++) {
          const d = features[i] - data.features[i];
          sum += d * d;
        }
        const dist = Math.sqrt(sum / features.length);
        if (dist < bestScore) {
          bestScore = dist;
          bestKey = hash;
        }
      }
    }

    if (bestScore < SIMILARITY_THRESHOLD) {
      const rec = seenFaces.get(bestKey);
      rec.timestamp = now;
      rec.features = emaFeatures(rec.features, features);
      rec.bbox = bbox;
      return { known: true, key: bestKey };
    }

    return { known: false, key: null };
  }

  function markFaceAsSent(pred, existingKey = null) {
    const features = extractFaceFeatures(pred);
    const bbox = getBBox(pred);
    const now = Date.now();

    if (existingKey && seenFaces.has(existingKey)) {
      const rec = seenFaces.get(existingKey);
      rec.features = emaFeatures(rec.features, features);
      rec.bbox = bbox;
      rec.timestamp = now;
      return existingKey;
    }

    const hash = 'face_' + now + '_' + Math.random().toString(36).slice(2, 9);
    seenFaces.set(hash, { timestamp: now, features, bbox, lastSent: 0 });
    return hash;
  }

  function cleanOldFaces() {
    const now = Date.now();
    for (const [hash, data] of seenFaces) {
      if (now - data.timestamp > DUPLICATE_TIMEOUT) seenFaces.delete(hash);
    }
    if (seenFaces.size > MAX_CACHE) {
      const entries = [...seenFaces.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDrop = entries.slice(0, seenFaces.size - MAX_CACHE);
      toDrop.forEach(([k]) => seenFaces.delete(k));
    }
  }

  // 6) Recibir frames del padre y detectar
  let lastCheck = 0;
  let Q = 0.85;

  window.addEventListener('message', async (e) => {
    const data = e.data;
    if (!data || data.type !== 'frame' || !data.bitmap) return;

    // Actualizar tamaño si cambia
    if (data.w && data.h && (data.w !== TARGET_W || data.h !== TARGET_H)) {
      TARGET_W = data.w;
      TARGET_H = data.h;
      c.width = TARGET_W;
      c.height = TARGET_H;
    }

    const now = performance.now();
    if (now - lastCheck < FACE_CHECK_INTERVAL) {
      data.bitmap.close?.();
      return;
    }
    lastCheck = now;

    // Pintar bitmap en canvas
    x.drawImage(data.bitmap, 0, 0, TARGET_W, TARGET_H);
    data.bitmap.close?.();

    try {
      // Limpiar caras viejas ocasionalmente
      // if (Math.random() < 0.1) cleanOldFaces();
      cleanOldFaces();

      const predictions = await model.estimateFaces(c, false);

      if (predictions.length) {
        const toSend = [];

        for (const pred of predictions) {
          const conf = Array.isArray(pred.probability) ? pred.probability[0] : 1;
          // if (conf <= FACE_CONFIDENCE_THRESHOLD) continue;
          if (!isBigEnough(pred, 0.08)) continue;
          if (isTooBig(pred)) continue;

          // const res = isFaceAlreadySent(pred);

          // const key = res.known ? res.key : null;
          // const lastSent = key && seenFaces.get(key)?.lastSent || 0;
          // if (res.known && (Date.now() - lastSent < MIN_SEND_INTERVAL)) {
          //   console.log('↩︎ Cara conocida (no envío)');
          //   markFaceAsSent(pred, res.key);
          // } else {
          //   console.log('➕ Cara NUEVA (enviar)');
          //   newFaces.push(pred);
          // }

          const res = isFaceAlreadySent(pred);
          const nowMs = Date.now();

          if (res.known) {
            const key = res.key;
            const lastSent = seenFaces.get(key)?.lastSent || 0;
            if (nowMs - lastSent < MIN_SEND_INTERVAL) {
              // misma cara, solo refrescamos su rastro
              markFaceAsSent(pred, key);
            } else {
              toSend.push({ pred, key }); // misma persona, vamos a ENVIAR usando su key
            }
          } else {
            // 1ª vez que la vemos: queda "pendiente" hasta confirmar
            const bbox = getBBox(pred);
            const k = keyFromBBox(bbox);
            const cand = pending.get(k);
            if (cand && (nowMs - cand.t) < NEW_FACE_CONFIRM_MS && isSimilarBBox(bbox, cand.bbox)) {
              pending.delete(k);
              const newKey = markFaceAsSent(pred); // crea entrada y devuelve hash
              toSend.push({ pred, key: newKey });
            } else {
              pending.set(k, { t: nowMs, bbox });
            }
          }
        }

        // Overlay controlado por config.json (booleano `overlay`).
        if (OVERLAY) {
          const boxes = predictions.map(p => {
            const [x1, y1] = p.topLeft;
            const [x2, y2] = p.bottomRight;
            const w = x2 - x1, h = y2 - y1;
            const cx = x1 + w / 2, cy = y1 + h / 2;

            // Ajustes:
            // - +10% de ancho ≈ cubrir orejas
            // - +20% de alto ≈ cubrir frente y barbilla
            const newW = w * 1.10;
            const newH = h * 1.20;

            let nx1 = cx - newW / 2, ny1 = cy - newH / 2;
            let nx2 = cx + newW / 2, ny2 = cy + newH / 2;

            // Limitar a los bordes del frame (TARGET_W/H están en tu archivo)
            nx1 = Math.max(0, nx1); ny1 = Math.max(0, ny1);
            nx2 = Math.min(TARGET_W, nx2); ny2 = Math.min(TARGET_H, ny2);

            return { x1: nx1, y1: ny1, x2: nx2, y2: ny2 };
          });

          parent.postMessage({ type: 'detections', boxes }, '*');
        } else {
          parent.postMessage({ type: 'detections', boxes: [] }, '*');
        }


        const num = predictions.length;
        const nowR = Date.now();
        if (num !== lastNumDetections || (nowR - lastDetectReport) > DETECT_REPORT_MIN_MS) {
          report(`Detectadas ${num} cara(s)`);
          lastNumDetections = num;
          lastDetectReport = nowR;
        }

        // Enviar frames con caras nuevas
        if (toSend.length && ws && ws.readyState === 1) {
          // Registrar/actualizar exactamente esas caras (usando su key)
          toSend.forEach(({ pred, key }) => markFaceAsSent(pred, key));

          // Control de backpressure
          const buf = ws.bufferedAmount;
          if (buf > 4_000_000) {
            Q = Math.max(0.75, Q - 0.05);
          } else if (buf < 500_000 && Q < 0.9) {
            Q = Math.min(0.9, Q + 0.01);
          }

          c.toBlob(async (b) => {
            if (!b) return;
            const ab = await b.arrayBuffer();
            ws.send(ab);
            const now = Date.now();
            for (const [k, rec] of seenFaces) rec.lastSent = now;
            const active = [...seenFaces.values()].filter(r => Date.now() - r.timestamp <= DUPLICATE_TIMEOUT).length;

            report(`✓ Frame enviado (${active} caras en memoria)`);
            console.log(`📤 Frame enviado con ${toSend.length} cara(s) lista(s)`);
          }, 'image/jpeg', Q);
        }
      } else {
        report('Sin caras detectadas');
        parent.postMessage({ type: 'detections', boxes: [] }, '*');
      }
    } catch (err) {
      console.error('❌ Error en detección:', err);
      report('Error: ' + err.message);
    }
  });

  console.log('✅ Detector inicializado');
})();