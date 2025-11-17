(async function () {
  // ============================================================
  // CONFIGURACIÓN
  // ============================================================
  const { WS_URL, OVERLAY } = await (async function getConfig() {
    const res = await fetch('../config.json', { cache: 'no-store' });
    const cfg = await res.json();
    return { 
      WS_URL: cfg.WS_URL, 
      OVERLAY: (typeof cfg.overlay === 'boolean') ? cfg.overlay : true 
    };
  })();

  // Parámetros de detección y tracking
  const CONFIG = {
    FACE_CONFIDENCE_THRESHOLD: 0.7,
    DUPLICATE_TIMEOUT: 10 * 1000,
    FACE_CHECK_INTERVAL: 500,
    MIN_SEND_INTERVAL: 2000,
    NEW_FACE_CONFIRM_MS: 600,
    MAX_CACHE: 50,
    MIN_FACE_SIZE: 0.08,
    MAX_FACE_SIZE: 0.6,
    DETECT_REPORT_MIN_MS: 1200,
    JPEG_QUALITY: 0.85,
    MAX_BACKPRESSURE: 4_000_000
  };

  // ============================================================
  // ESTADO GLOBAL
  // ============================================================
  const seenFaces = new Map();
  const pending = new Map();
  let lastNumDetections = -1;
  let lastDetectReport = 0;
  let lastCheck = 0;
  let jpegQuality = CONFIG.JPEG_QUALITY;

  // ============================================================
  // UTILIDADES
  // ============================================================
  function report(msg) {
    try {
      parent.postMessage({ type: 'status', msg }, '*');
    } catch (e) {
      console.log(msg);
    }
  }

  function getBBox(detection) {
    const box = detection.detection.box;
    const cx = (box.x + box.width / 2) / TARGET_W;
    const cy = (box.y + box.height / 2) / TARGET_H;
    const w = box.width / TARGET_W;
    const h = box.height / TARGET_H;
    return { cx, cy, w, h };
  }

  function keyFromBBox(b) {
    const cx = Math.round(b.cx * 20);
    const cy = Math.round(b.cy * 20);
    const s = Math.round(Math.hypot(b.w, b.h) * 20);
    return `${cx}_${cy}_${s}`;
  }

  function isSimilarBBox(b1, b2, centerTol = 0.03, sizeTol = 0.08) {
    const dcx = Math.abs(b1.cx - b2.cx);
    const dcy = Math.abs(b1.cy - b2.cy);
    const dw = Math.abs(b1.w - b2.w);
    const dh = Math.abs(b1.h - b2.h);
    return (dcx < centerTol && dcy < centerTol && dw < sizeTol && dh < sizeTol);
  }

  function extractDescriptor(detection) {
    // Face-API.js proporciona un descriptor de 128 dimensiones
    return detection.descriptor ? Array.from(detection.descriptor) : null;
  }

  function compareDescriptors(desc1, desc2) {
    if (!desc1 || !desc2 || desc1.length !== desc2.length) return 1;
    
    // Distancia euclidiana
    let sum = 0;
    for (let i = 0; i < desc1.length; i++) {
      const d = desc1[i] - desc2[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  function isFaceAlreadySent(detection) {
    const now = Date.now();
    const descriptor = extractDescriptor(detection);
    const bbox = getBBox(detection);
    let bestKey = null;
    let bestScore = Infinity;

    for (const [hash, data] of seenFaces.entries()) {
      if (now - data.timestamp > CONFIG.DUPLICATE_TIMEOUT) continue;

      // Comparación por descriptor (más preciso que landmarks)
      if (descriptor && data.descriptor) {
        const dist = compareDescriptors(descriptor, data.descriptor);
        if (dist < bestScore) {
          bestScore = dist;
          bestKey = hash;
        }
      }

      // Fallback: comparación por bbox
      if (data.bbox && isSimilarBBox(bbox, data.bbox)) {
        data.timestamp = now;
        data.descriptor = descriptor;
        data.bbox = bbox;
        return { known: true, key: hash };
      }
    }

    // Umbral de similitud para descriptores (ajustable)
    if (bestScore < 0.6) {
      const rec = seenFaces.get(bestKey);
      rec.timestamp = now;
      rec.descriptor = descriptor;
      rec.bbox = bbox;
      return { known: true, key: bestKey };
    }

    return { known: false, key: null };
  }

  function markFaceAsSent(detection, existingKey = null) {
    const descriptor = extractDescriptor(detection);
    const bbox = getBBox(detection);
    const now = Date.now();

    if (existingKey && seenFaces.has(existingKey)) {
      const rec = seenFaces.get(existingKey);
      rec.descriptor = descriptor;
      rec.bbox = bbox;
      rec.timestamp = now;
      return existingKey;
    }

    const hash = 'face_' + now + '_' + Math.random().toString(36).slice(2, 9);
    seenFaces.set(hash, { 
      timestamp: now, 
      descriptor, 
      bbox, 
      lastSent: 0 
    });
    return hash;
  }

  function cleanOldFaces() {
    const now = Date.now();
    for (const [hash, data] of seenFaces) {
      if (now - data.timestamp > CONFIG.DUPLICATE_TIMEOUT) {
        seenFaces.delete(hash);
      }
    }
    
    if (seenFaces.size > CONFIG.MAX_CACHE) {
      const entries = [...seenFaces.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDrop = entries.slice(0, seenFaces.size - CONFIG.MAX_CACHE);
      toDrop.forEach(([k]) => seenFaces.delete(k));
    }
  }

  function isFaceSizeValid(detection) {
    const box = detection.detection.box;
    const w = box.width / TARGET_W;
    const h = box.height / TARGET_H;
    return w >= CONFIG.MIN_FACE_SIZE && 
           h >= CONFIG.MIN_FACE_SIZE && 
           w <= CONFIG.MAX_FACE_SIZE && 
           h <= CONFIG.MAX_FACE_SIZE;
  }

  // ============================================================
  // INICIALIZACIÓN DE FACE-API.JS
  // ============================================================
  if (typeof faceapi === 'undefined') {
    report('❌ Face-API.js no cargado');
    return;
  }

  report('Cargando modelos Face-API.js...');

  // Determinar ruta de modelos
  const modelsPath = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
    ? chrome.runtime.getURL('models/faceapi/')
    : new URL('../models/faceapi/', location.href).toString();

  console.log('📦 Cargando modelos desde:', modelsPath);

  try {
    // Cargar modelos necesarios
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(modelsPath),
      faceapi.nets.faceLandmark68Net.loadFromUri(modelsPath),
      faceapi.nets.faceRecognitionNet.loadFromUri(modelsPath),
      faceapi.nets.ageGenderNet.loadFromUri(modelsPath),
      faceapi.nets.faceExpressionNet.loadFromUri(modelsPath)
    ]);

    report('✅ Modelos cargados. Esperando frames...');
  } catch (error) {
    report('❌ Error cargando modelos: ' + error.message);
    console.error(error);
    return;
  }

  // ============================================================
  // CANVAS DE TRABAJO
  // ============================================================
  let TARGET_W = 640, TARGET_H = 480;
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // ============================================================
  // WEBSOCKET
  // ============================================================
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

  // ============================================================
  // PROCESAMIENTO DE FRAMES
  // ============================================================
  window.addEventListener('message', async (e) => {
    const data = e.data;
    if (!data || data.type !== 'frame' || !data.bitmap) return;

    // Actualizar dimensiones si cambian
    if (data.w && data.h && (data.w !== TARGET_W || data.h !== TARGET_H)) {
      TARGET_W = data.w;
      TARGET_H = data.h;
      canvas.width = TARGET_W;
      canvas.height = TARGET_H;
    }

    const now = performance.now();
    if (now - lastCheck < CONFIG.FACE_CHECK_INTERVAL) {
      data.bitmap.close?.();
      return;
    }
    lastCheck = now;

    // Pintar bitmap en canvas
    ctx.drawImage(data.bitmap, 0, 0, TARGET_W, TARGET_H);
    data.bitmap.close?.();

    try {
      cleanOldFaces();

      // ============================================================
      // DETECCIÓN CON FACE-API.JS
      // Incluye: detección + landmarks + descriptor + edad + género + expresiones
      // ============================================================
      const detections = await faceapi
        .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({
          inputSize: 416,
          scoreThreshold: CONFIG.FACE_CONFIDENCE_THRESHOLD
        }))
        .withFaceLandmarks()
        .withFaceDescriptors()
        .withAgeAndGender()
        .withFaceExpressions();

      if (detections.length) {
        const toSend = [];

        for (const detection of detections) {
          if (!isFaceSizeValid(detection)) continue;

          const res = isFaceAlreadySent(detection);
          const nowMs = Date.now();

          if (res.known) {
            const key = res.key;
            const lastSent = seenFaces.get(key)?.lastSent || 0;
            
            if (nowMs - lastSent < CONFIG.MIN_SEND_INTERVAL) {
              markFaceAsSent(detection, key);
            } else {
              toSend.push({ detection, key });
            }
          } else {
            // Nueva cara: confirmación antes de enviar
            const bbox = getBBox(detection);
            const k = keyFromBBox(bbox);
            const cand = pending.get(k);
            
            if (cand && 
                (nowMs - cand.t) < CONFIG.NEW_FACE_CONFIRM_MS && 
                isSimilarBBox(bbox, cand.bbox)) {
              pending.delete(k);
              const newKey = markFaceAsSent(detection);
              toSend.push({ detection, key: newKey });
            } else {
              pending.set(k, { t: nowMs, bbox });
            }
          }
        }

        // ============================================================
        // OVERLAY CON INFORMACIÓN ENRIQUECIDA
        // ============================================================
        if (OVERLAY) {
          const boxes = detections.map(d => {
            const box = d.detection.box;
            const age = Math.round(d.age);
            const gender = d.gender;
            const genderProb = Math.round(d.genderProbability * 100);
            
            // Expresión dominante
            const expressions = d.expressions;
            const dominantExpression = Object.entries(expressions)
              .sort((a, b) => b[1] - a[1])[0];
            const [emotion, emotionProb] = dominantExpression;
            
            // Expandir bbox
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            const newW = box.width * 1.10;
            const newH = box.height * 1.20;
            
            let x1 = Math.max(0, cx - newW / 2);
            let y1 = Math.max(0, cy - newH / 2);
            let x2 = Math.min(TARGET_W, cx + newW / 2);
            let y2 = Math.min(TARGET_H, cy + newH / 2);

            // Color según emoción
            const emotionColors = {
              happy: '#00ff00',
              sad: '#0080ff',
              angry: '#ff0000',
              surprised: '#ffff00',
              neutral: '#ffffff',
              disgusted: '#ff00ff',
              fearful: '#ff8000'
            };

            return {
              x1, y1, x2, y2,
              color: emotionColors[emotion] || '#00ff00',
              label: `${gender} ${age}y - ${emotion} ${Math.round(emotionProb * 100)}%`
            };
          });

          parent.postMessage({ type: 'detections', boxes }, '*');
        } else {
          parent.postMessage({ type: 'detections', boxes: [] }, '*');
        }

        // Reportar detecciones
        const num = detections.length;
        const nowR = Date.now();
        if (num !== lastNumDetections || 
            (nowR - lastDetectReport) > CONFIG.DETECT_REPORT_MIN_MS) {
          report(`Detectadas ${num} cara(s)`);
          lastNumDetections = num;
          lastDetectReport = nowR;
        }

        // ============================================================
        // ENVÍO POR WEBSOCKET
        // ============================================================
        if (toSend.length && ws && ws.readyState === 1) {
          toSend.forEach(({ detection, key }) => {
            markFaceAsSent(detection, key);
            
            // Actualizar metadata de la cara en seenFaces
            const rec = seenFaces.get(key);
            if (rec) {
              rec.age = Math.round(detection.age);
              rec.gender = detection.gender;
              rec.genderProbability = detection.genderProbability;
              rec.expressions = detection.expressions;
            }
          });

          // Control de backpressure
          const buf = ws.bufferedAmount;
          if (buf > CONFIG.MAX_BACKPRESSURE) {
            jpegQuality = Math.max(0.75, jpegQuality - 0.05);
          } else if (buf < 500_000 && jpegQuality < 0.9) {
            jpegQuality = Math.min(0.9, jpegQuality + 0.01);
          }

          canvas.toBlob(async (blob) => {
            if (!blob) return;
            
            const ab = await blob.arrayBuffer();
            ws.send(ab);
            
            const now = Date.now();
            for (const [k, rec] of seenFaces) {
              rec.lastSent = now;
            }
            
            const active = [...seenFaces.values()]
              .filter(r => Date.now() - r.timestamp <= CONFIG.DUPLICATE_TIMEOUT)
              .length;

            report(`✓ Frame enviado (${active} caras en memoria)`);
            console.log(`📤 Frame con ${toSend.length} cara(s)`, 
              toSend.map(({ detection }) => ({
                age: Math.round(detection.age),
                gender: detection.gender,
                emotion: Object.entries(detection.expressions)
                  .sort((a, b) => b[1] - a[1])[0][0]
              }))
            );
          }, 'image/jpeg', jpegQuality);
        }
      } else {
        parent.postMessage({ type: 'detections', boxes: [] }, '*');
      }
    } catch (err) {
      console.error('❌ Error en detección:', err);
      report('Error: ' + err.message);
    }
  });

  console.log('✅ Detector Face-API.js inicializado');
})();