(async () => {
  const statusEl = document.getElementById('status');
  statusEl.classList.remove('hud');
  statusEl.classList.add('feed');
  statusEl.textContent = ''; // que empiece vacío

  const iframe = document.getElementById('sandbox');
  const overlay = document.getElementById('overlay');
  const octx = overlay.getContext('2d');
  const mirror = document.getElementById('mirror');
  const mctx = mirror.getContext('2d', { alpha: false, desynchronized: true });

  // Esperar a que el iframe cargue
  await new Promise(res => {
    if (iframe.contentWindow) return res();
    iframe.addEventListener('load', res, { once: true });
  });

  // Crear y mostrar el video
  const videoEl = document.createElement('video');
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.muted = true;
  videoEl.id = 'video';
  // document.getElementById('preview').prepend(videoEl); // (no insertamos el <video> en el DOM; se usa solo como fuente)

  // Pedir la cámara
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: false
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    statusEl.textContent = '✓ Cámara OK';
  } catch (e) {
    statusEl.textContent = '❌ Error cámara: ' + e.message;
    console.error(e);
    return;
  }

  const TARGET_W = 1280, TARGET_H = 720;
  const canva = document.createElement('canvas');
  canva.width = TARGET_W;
  canva.height = TARGET_H;

  mirror.width = TARGET_W;
  mirror.height = TARGET_H;

  const ctx = canva.getContext('2d', { willReadFrequently: true });

  function resizeOverlay() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / TARGET_W, vh / TARGET_H);
    const dispW = Math.round(TARGET_W * scale);
    const dispH = Math.round(TARGET_H * scale);

    overlay.width = dispW;
    overlay.height = dispH;

    mirror.style.width = dispW + 'px';
    mirror.style.height = dispH + 'px';
  }

  function appendStatus(msg) {
    if (!msg) return;

    // (Opcional) filtra spam muy frecuente
    if (msg.includes('Sin caras detectadas')) return;

    const el = document.createElement('div');
    el.className = 'bubble';

    // etiquetas visuales según el texto del mensaje
    if (msg.includes('WS conectado')) el.classList.add('connected');
    else if (msg.includes('Detectadas')) el.classList.add('detecting');
    else if (msg.includes('enviado')) el.classList.add('sending');
    else if (msg.toLowerCase().includes('error') || msg.includes('❌')) el.classList.add('error');

    el.textContent = msg;
    statusEl.prepend(el);                   // aparece abajo
    if (statusEl.childElementCount > 8) {   // límite de “burbujas” visibles
      statusEl.lastElementChild?.remove();
    }
    setTimeout(() => el.remove(), 5500);    // desaparece solo
  }

  window.addEventListener('resize', resizeOverlay);
  videoEl.addEventListener('loadedmetadata', resizeOverlay);
  resizeOverlay();

  (function mirrorLoop() {
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.drawImage(canva, 0, 0, mirror.width, mirror.height);

    setTimeout(() => requestAnimationFrame(mirrorLoop), 1000 / 15); // ~15 fps
  })();

  // Loop: enviar frames al sandbox para detección
  function tick() {
    if (videoEl.videoWidth && videoEl.videoHeight) {
      ctx.drawImage(videoEl, 0, 0, TARGET_W, TARGET_H);

      createImageBitmap(canva).then(bitmap => {
        iframe.contentWindow.postMessage(
          { type: 'frame', bitmap, w: TARGET_W, h: TARGET_H },
          '*',
          [bitmap]
        );
      }).catch(console.error);
    }
    requestAnimationFrame(tick);
  }
  tick();

  // Recibir mensajes del sandbox
  window.addEventListener('message', e => {
    if (!e.data) return;

    // Actualizar estado
    if (e.data.type === 'status') {
      appendStatus(e.data.msg || '');
      // statusEl.textContent = e.data.msg || '';

      // // Aplicar clases CSS según el estado
      // statusEl.className = 'hud';
      // if (e.data.msg && e.data.msg.includes('WS conectado')) {
      //   statusEl.classList.add('connected');
      // } else if (e.data.msg && e.data.msg.includes('Detectadas')) {
      //   statusEl.classList.add('detecting');
      // } else if (e.data.msg && e.data.msg.includes('enviado')) {
      //   statusEl.classList.add('sending');
      // }
    }
    // Dibujar detecciones en el overlay
    else if (e.data.type === 'detections') {
      const boxes = e.data.boxes || [];

      // Escalar coordenadas del canvas de detección al overlay visible
      const sX = overlay.width / TARGET_W;
      const sY = overlay.height / TARGET_H;

      octx.clearRect(0, 0, overlay.width, overlay.height);
      octx.save();

      for (const d of boxes) {
        const rx = d.x1 * sX;
        const ry = d.y1 * sY;
        const rw = (d.x2 - d.x1) * sX;
        const rh = (d.y2 - d.y1) * sY;

        octx.lineWidth = 1;
        octx.strokeStyle = d.color || 'lime';
        octx.shadowColor = octx.strokeStyle;
        octx.shadowBlur = 0;
        octx.strokeRect(rx, ry, rw, rh);

        // Etiqueta
        const label = d.label || 'face';
        octx.shadowBlur = 0;
        octx.fillStyle = octx.strokeStyle;
        octx.font = '12px sans-serif';
        const w = octx.measureText(label).width;
        octx.fillRect(rx, ry - 16, w + 6, 14);
        octx.fillStyle = '#000';
        octx.fillText(label, rx + 3, ry - 4);
      }

      octx.restore();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 's') {
      mirror.toBlob((b) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = 'snapshot.jpg';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      }, 'image/jpeg', 0.9);
    }
  });
})();