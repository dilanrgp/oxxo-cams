(function () {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;

    HTMLCanvasElement.prototype.getContext = function (type, options) {
        if (type === '2d') {
            if (!options || typeof options !== 'object') {
                options = { willReadFrequently: true };
            } else if (options.willReadFrequently !== true) {
                options = Object.assign({}, options, { willReadFrequently: true });
            }
        }
        return originalGetContext.call(this, type, options);
    };
})();

const elVideo = document.getElementById('video')

navigator.getMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia)

const cargarCamera = () => {
    navigator.getMedia(
        {
            video: true,
            audio: false
        },
        stream => elVideo.srcObject = stream,
        console.error
    )
}

// =========================
// Config e IDs de caras
// =========================

let config = {
    // valores por defecto, se sobreescriben con config.json si existe
    faceRetentionMs: 5 * 60 * 1000,
    customerId: null,
    siteId: null,
    cameraId: null,
    email: null,
    detectArea: null, // { enabled, x, y, width, height } en píxeles

    // Estilo por defecto para el área de detección
    detectAreaStyle: {
        color: 'red',
        lineWidth: 2,
        lineDash: [6, 4]
    },

    // Mostrar / ocultar contador de género
    showGenderCounter: false
}

// Umbral máximo de distancia para considerar que es la misma cara
let FACE_MATCH_THRESHOLD = 0.6

// Suavizado de edad (0–1). Cuanto más alto, más rápido cambia;
// cuanto más bajo, más estable pero más lento en ajustarse.
const AGE_SMOOTHING_FACTOR = 0.25

// "Base de datos" en memoria de caras conocidas
// Guardamos también edad y género para poder loguearlos cuando expire
// Estructura: { id, descriptors: Float32Array[], lastSeen, age, gender }
let knownFaces = []
let nextFaceId = 1

// Máximo número de descriptores que guardamos por cara
const MAX_DESCRIPTORS_PER_FACE = 5

// Contador de género (caras nuevas vistas)
const genderCounts = {
    male: 0,
    female: 0
}

// Cargar configuración desde config.json
function loadConfig() {
    if (!window.fetch) {
        console.warn('fetch no está disponible, se usan valores por defecto de configuración.')
        return
    }

    fetch('../config.json')
        .then(response => {
            if (!response.ok) {
                throw new Error('Respuesta no OK al cargar config.json')
            }
            return response.json()
        })
        .then(data => {
            if (data && typeof data.faceRetentionMinutes === 'number') {
                config.faceRetentionMs = data.faceRetentionMinutes * 60 * 1000
            }
            if (data && typeof data.faceMatchThreshold === 'number') {
                FACE_MATCH_THRESHOLD = data.faceMatchThreshold
            }

            // NUEVOS CAMPOS: customerid, idsite, idcamera, email
            if (data && typeof data.customerid !== 'undefined') {
                config.customerId = Number(data.customerid)
            }
            // por compatibilidad, si usas todavía customer_id antiguo
            if (data && typeof data.customer_id !== 'undefined' && config.customerId == null) {
                config.customerId = Number(data.customer_id)
            }

            if (data && typeof data.idsite !== 'undefined') {
                config.siteId = Number(data.idsite)
            }

            if (data && typeof data.idcamera !== 'undefined') {
                config.cameraId = Number(data.idcamera)
            }

            if (data && typeof data.email === 'string') {
                config.email = data.email
            }

            // Área de detección + estilo
            if (data && data.detectArea) {
                const da = data.detectArea
                config.detectArea = {
                    enabled: da.enabled !== false,
                    x: typeof da.x === 'number' ? da.x : 0,
                    y: typeof da.y === 'number' ? da.y : 0,
                    width: typeof da.width === 'number' ? da.width : elVideo.width,
                    height: typeof da.height === 'number' ? da.height : elVideo.height
                }

                if (da.style) {
                    const st = da.style
                    config.detectAreaStyle = {
                        color: typeof st.color === 'string' ? st.color : config.detectAreaStyle.color,
                        lineWidth: typeof st.lineWidth === 'number' ? st.lineWidth : config.detectAreaStyle.lineWidth,
                        lineDash: Array.isArray(st.lineDash) ? st.lineDash : config.detectAreaStyle.lineDash
                    }
                }
            }

            // Mostrar / ocultar contador de género
            if (data && typeof data.showGenderCounter === 'boolean') {
                config.showGenderCounter = data.showGenderCounter
            }

            console.log('Config cargada:', config, 'threshold:', FACE_MATCH_THRESHOLD)
        })
        .catch(err => {
            console.warn('No se pudo cargar config.json, usando valores por defecto.', err)
        })
}




// Llamamos a la carga de config al inicio
loadConfig()

// Calcula ts (timestamp en segundos) y keyhash (SHA-256 de ts + secret)
async function getTimestampAndKeyhash() {
    const ts = Date.now() // milisegundos
    const secret = 'ALRIDKJCS1SYADSKJDFS'
    const key = String(ts) + secret

    if (!window.crypto || !window.crypto.subtle) {
        console.error('Web Crypto API no disponible, no se puede calcular keyhash')
        return { ts, keyhash: '' }
    }

    const encoder = new TextEncoder()
    const data = encoder.encode(key)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const keyhash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

    return { ts, keyhash }
}

function getAgeType(age) {
    if (typeof age !== 'number') return ''
    if (age < 15) return 'child'
    if (age < 36) return 'young'
    if (age < 66) return 'adult'
    return 'senior'
}

async function sendFaceExpiredToApi(face, now) {
    try {
        if (
            config.customerId == null ||
            config.siteId == null ||
            config.cameraId == null ||
            !config.email
        ) {
            console.warn('Config incompleta, no se envía a la API.', config)
            return
        }

        const { ts, keyhash } = await getTimestampAndKeyhash()

        const url = `${config.apiurl}?timestamp=${ts}&keyhash=${keyhash}`

        const ageNumber = (typeof face.age === 'number') ? Math.round(face.age) : null
        const genderStr = face.gender || null
        const ageType = getAgeType(ageNumber ?? 0)

        // duration: tiempo en la zona de detección (en segundos)
        const start = (typeof face.firstSeen === 'number') ? face.firstSeen : face.lastSeen || now
        const end = (typeof face.lastSeen === 'number') ? face.lastSeen : now
        const durationSec = Math.max(0, Math.round((end - start) / 1000))

        // fecha/hora de envío (puedes ajustar el formato si el backend exige algo concreto)
        const date_time = new Date(end).toISOString()

        const payload = {
            customer_id: Number(config.customerId),
            site_id: Number(config.siteId),
            camera_id: Number(config.cameraId),
            email: config.email,
            gender: genderStr,
            type: ageType,
            age: ageNumber,
            duration: durationSec,
            positions: [
                { x: 112.2, y: 334.4 },
                { x: 556.6, y: 778.8 },
            ],      // por ahora vacío, como comentaste
            datetime: date_time
        }

        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            console.error('Error al enviar datos a la API:', response.status, text)
        } else {
            // Si quieres ver algo en consola mientras pruebas:
            console.log('FACE_EXPIRED enviado a API:', payload)
        }
    } catch (err) {
        console.error('Excepción al enviar datos a la API:', err)
    }
}


// Dado un descriptor de cara, devuelve un ID existente o crea uno nuevo
// Ahora también recibimos edad y género para guardarlos
function getOrCreateFaceId(descriptor, age, gender, excludedFaceIds = new Set()) {
    if (!descriptor) {
        return null
    }

    const now = Date.now()

    // Normalizamos el texto de género a 'male' / 'female' si viene algo raro
    const normalizedGender =
        gender === 'male' || gender === 'female'
            ? gender
            : null

    // Buscar la cara conocida más parecida (distancia euclídea mínima)
    let bestMatchFace = null
    let bestDistance = Infinity

    knownFaces.forEach(face => {

        if (excludedFaceIds.has(face.id)) {
            return
        }

        // Comparamos contra TODOS los descriptores de esa cara
        face.descriptors.forEach(storedDescriptor => {
            const distance = faceapi.euclideanDistance(storedDescriptor, descriptor)
            if (distance < bestDistance) {
                bestDistance = distance
                bestMatchFace = face
            }
        })
    })

    // Si hay una cara suficientemente parecida, reutilizamos su ID
    if (bestMatchFace && bestDistance <= FACE_MATCH_THRESHOLD) {
        // Actualizamos la marca de tiempo y, opcionalmente, añadimos este descriptor
        bestMatchFace.lastSeen = now
        // --- Suavizado de edad ---
        if (typeof age === 'number') {
            if (typeof bestMatchFace.age === 'number') {
                const alpha = AGE_SMOOTHING_FACTOR
                bestMatchFace.age =
                    bestMatchFace.age * (1 - alpha) + age * alpha
            } else {
                // Primera vez que tenemos edad para esta cara
                bestMatchFace.age = age
            }
        }
        bestMatchFace.gender = normalizedGender || gender

        // Añadimos el nuevo descriptor para mejorar robustez, con un máximo
        if (bestMatchFace.descriptors.length < MAX_DESCRIPTORS_PER_FACE) {
            bestMatchFace.descriptors.push(descriptor)
        } else {
            // Si está lleno, podemos sustituir el más antiguo / aleatorio, aquí quitamos el primero
            bestMatchFace.descriptors.shift()
            bestMatchFace.descriptors.push(descriptor)
        }

        return bestMatchFace.id
    }

    // Si no, creamos una nueva entrada con este descriptor
    const newFace = {
        id: nextFaceId++,
        descriptors: [descriptor],
        firstSeen: now,          // NUEVO: marca de tiempo de primera vez visto
        lastSeen: now,           // última vez visto
        age,
        gender: normalizedGender || gender
    }
    knownFaces.push(newFace)

    // Contador de género: solo incrementa cuando la cara es realmente nueva
    if (normalizedGender === 'male') {
        genderCounts.male++
    } else if (normalizedGender === 'female') {
        genderCounts.female++
    }

    return newFace.id
}


// Helper: comprobar si la caja está dentro del área de detección
function isInDetectArea(box) {
    if (!config.detectArea || config.detectArea.enabled === false) {
        // si no hay área configurada, aceptamos todas las caras
        return true
    }

    const area = config.detectArea

    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2

    const areaRight = area.x + area.width
    const areaBottom = area.y + area.height

    return (
        centerX >= area.x &&
        centerX <= areaRight &&
        centerY >= area.y &&
        centerY <= areaBottom
    )
}

// Dibujar contador de género arriba a la derecha del canvas
function drawGenderCounter(ctx, canvas) {
    if (!config.showGenderCounter) {
        return
    }

    const padding = 10
    const lineHeight = 18
    const boxWidth = 140
    const boxHeight = padding * 2 + lineHeight * 2

    const x = canvas.width - boxWidth - padding
    const y = padding

    ctx.save()

    // Fondo semitransparente
    ctx.globalAlpha = 0.6
    ctx.fillStyle = 'black'
    ctx.fillRect(x, y, boxWidth, boxHeight)

    // Borde
    ctx.globalAlpha = 1
    ctx.strokeStyle = 'white'
    ctx.lineWidth = 1
    ctx.strokeRect(x, y, boxWidth, boxHeight)

    // Texto
    ctx.fillStyle = 'white'
    ctx.font = '14px Arial'
    ctx.fillText(`M: ${genderCounts.male}`, x + 8, y + 16)
    ctx.fillText(`F: ${genderCounts.female}`, x + 8, y + 16 + lineHeight)

    ctx.restore()
}

// =========================
// Cargar Modelos
// =========================

Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri('../models'),
    faceapi.nets.ageGenderNet.loadFromUri('../models'),
    faceapi.nets.faceExpressionNet.loadFromUri('../models'),
    faceapi.nets.faceLandmark68Net.loadFromUri('../models'),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri('../models'),
    faceapi.nets.faceRecognitionNet.loadFromUri('../models'),
    faceapi.nets.ssdMobilenetv1.loadFromUri('../models'),
    faceapi.nets.tinyFaceDetector.loadFromUri('../models'),
]).then(cargarCamera)

elVideo.addEventListener('play', async () => {
    // creamos el canvas con los elementos de la face api
    const canvas = faceapi.createCanvasFromMedia(elVideo)
    // lo añadimos al body
    document.body.append(canvas)

    // tamaño del canvas
    const displaySize = { width: elVideo.width, height: elVideo.height }
    faceapi.matchDimensions(canvas, displaySize)

    setInterval(async () => {
        const now = Date.now()

        // 1. Buscar caras que han expirado (pasado el tiempo configurado)
        const expiredFaces = knownFaces.filter(face => (now - face.lastSeen) > config.faceRetentionMs)

        // 1.1. Enviar a la API por cada cara que expira
        expiredFaces.forEach(face => {
            // Llamada asíncrona, no esperamos a que termine para seguir con el loop de vídeo
            sendFaceExpiredToApi(face, now)
        })

        // 1.2. Limpiar caras que llevan más de X ms sin verse
        knownFaces = knownFaces.filter(face => (now - face.lastSeen) <= config.faceRetentionMs)

        // 2. Hacer las detecciones de cara
        const detections = await faceapi
            .detectAllFaces(elVideo)
            .withFaceLandmarks()
            .withFaceExpressions()
            .withAgeAndGender()
            .withFaceDescriptors()

        // Ajustar detecciones al tamaño del vídeo
        const resizedDetections = faceapi.resizeResults(detections, displaySize)

        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        // 3. Limpiar el canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        // 3.1 Dibujar área de detección, si está configurada
        if (config.detectArea && config.detectArea.enabled !== false) {
            ctx.save()

            const areaStyle = config.detectAreaStyle || {}

            ctx.strokeStyle = areaStyle.color || 'red'
            ctx.lineWidth = typeof areaStyle.lineWidth === 'number' ? areaStyle.lineWidth : 2

            if (Array.isArray(areaStyle.lineDash) && areaStyle.lineDash.length > 0) {
                ctx.setLineDash(areaStyle.lineDash)
            } else {
                ctx.setLineDash([])
            }

            ctx.strokeRect(
                config.detectArea.x,
                config.detectArea.y,
                config.detectArea.width,
                config.detectArea.height
            )
            ctx.restore()
        }

        const usedFaceIdsThisFrame = new Set()

        // 3.2 Dibujar las cajas con el ID SOLO si están dentro del área
        resizedDetections.forEach((detection, index) => {
            const box = detection.detection.box

            // Si la cara no está dentro del área de detección, la ignoramos
            if (!isInDetectArea(box)) {
                return
            }

            // Usamos descriptor, edad y género del objeto original (no redimensionado)
            const descriptor = detections[index].descriptor
            const rawAge = detections[index].age
            const rawGender = detections[index].gender

            const faceId = getOrCreateFaceId(descriptor, rawAge, rawGender, usedFaceIdsThisFrame)

            // Si por algún motivo no devuelve ID, no dibujamos nada
            if (faceId == null) {
                return
            }

            usedFaceIdsThisFrame.add(faceId)

            // Buscar la cara en nuestra "base de datos" para usar la edad suavizada
            const faceData = knownFaces.find(f => f.id === faceId)

            const displayAge = (faceData && typeof faceData.age === 'number')
                ? Math.round(faceData.age)
                : Math.round(rawAge)

            const displayGender = (faceData && faceData.gender)
                ? faceData.gender
                : rawGender

            const label = `ID ${faceId} - ${displayAge} years ${displayGender}`

            new faceapi.draw.DrawBox(box, {
                label
            }).draw(canvas)
        })

        // 3.3 Dibujar contador de género (si está activado)
        drawGenderCounter(ctx, canvas)
    }, 80)
})
