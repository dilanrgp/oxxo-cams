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
    customerId: null
}

// Umbral máximo de distancia para considerar que es la misma cara
let FACE_MATCH_THRESHOLD = 0.6

// "Base de datos" en memoria de caras conocidas
// Guardamos también edad y género para poder loguearlos cuando expire
let knownFaces = [] // { id, descriptor, lastSeen, age, gender }
let nextFaceId = 1

// Cargar configuración desde config.json
function loadConfig() {
    if (!window.fetch) {
        console.warn('fetch no está disponible, se usan valores por defecto de configuración.')
        return
    }

    fetch('./config.json')
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
            if (data && typeof data.customer_id !== 'undefined') {
                config.customerId = data.customer_id
            }
            console.log('Config cargada:', config, 'threshold:', FACE_MATCH_THRESHOLD)
        })
        .catch(err => {
            console.warn('No se pudo cargar config.json, usando valores por defecto.', err)
        })
}

// Llamamos a la carga de config al inicio
loadConfig()

// Dado un descriptor de cara, devuelve un ID existente o crea uno nuevo
// Ahora también recibimos edad y género para guardarlos
function getOrCreateFaceId(descriptor, age, gender) {
    if (!descriptor) {
        return null
    }

    const now = Date.now()

    // Buscar la cara conocida más parecida (distancia euclídea mínima)
    let bestMatchId = null
    let bestDistance = Infinity

    knownFaces.forEach(face => {
        const distance = faceapi.euclideanDistance(face.descriptor, descriptor)
        if (distance < bestDistance) {
            bestDistance = distance
            bestMatchId = face.id
        }
    })

    // Si hay una cara suficientemente parecida, reutilizamos su ID
    if (bestMatchId !== null && bestDistance <= FACE_MATCH_THRESHOLD) {
        const face = knownFaces.find(f => f.id === bestMatchId)
        if (face) {
            face.descriptor = descriptor
            face.lastSeen = now
            face.age = age
            face.gender = gender
        }
        return bestMatchId
    }

    // Si no, creamos una nueva entrada
    const newFace = {
        id: nextFaceId++,
        descriptor,
        lastSeen: now,
        age,
        gender
    }
    knownFaces.push(newFace)
    return newFace.id
}

// =========================
// Cargar Modelos
// =========================

Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri('./models'),
    faceapi.nets.ageGenderNet.loadFromUri('./models'),
    faceapi.nets.faceExpressionNet.loadFromUri('./models'),
    faceapi.nets.faceLandmark68Net.loadFromUri('./models'),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri('./models'),
    faceapi.nets.faceRecognitionNet.loadFromUri('./models'),
    faceapi.nets.ssdMobilenetv1.loadFromUri('./models'),
    faceapi.nets.tinyFaceDetector.loadFromUri('./models'),
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

        // 1.1. Hacer console.log por cada cara que expira
        expiredFaces.forEach(face => {
            const fechaHora = new Date(now).toLocaleString()
            const age = (typeof face.age === 'number') ? Math.round(face.age) : 'N/A'
            const gender = face.gender || 'N/A'
            const customerId = (config.customerId !== null && config.customerId !== undefined)
                ? config.customerId
                : 'N/A'

            console.log(
                `FACE_EXPIRED | customer_id: ${customerId} | id: ${face.id} | edad: ${age} | sexo: ${gender} | fecha_hora: ${fechaHora}`
            )
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

        // 3. Limpiar el canvas
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        // 4. Dibujar las cajas con el ID
        resizedDetections.forEach((detection, index) => {
            const box = detection.detection.box

            // Usamos descriptor, edad y género del objeto original (no redimensionado)
            const descriptor = detections[index].descriptor
            const age = detections[index].age
            const gender = detections[index].gender

            const faceId = getOrCreateFaceId(descriptor, age, gender)

            const label = `ID ${faceId} - ${Math.round(age)} años ${gender}`

            new faceapi.draw.DrawBox(box, {
                label
            }).draw(canvas)
        })
    }, 80)
})
