const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const socketIo = require('socket.io');
const http = require('http');
const twilio = require('twilio');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 4000;

// Crear servidor HTTP
const server = http.createServer(app);

// Configurar Socket.IO
const io = socketIo(server, {
    cors: {
        origin: 'https://sistema-rastreoarbe.vercel.app',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
}));
app.use(express.json());
app.use(express.static('public'));

// Configuración de la base de datos MySQL
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 30000
});

// Verificar conexión inicial
db.getConnection((err, connection) => {
    if (err) {
        console.error('Error al conectar a la base de datos al iniciar:', err);
        process.exit(1);
    }
    console.log('Conexión a la base de datos establecida');
    connection.release();
});

// Configuración de Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const recipientPhoneNumber = process.env.RECIPIENT_PHONE_NUMBER;

if (!accountSid || !authToken || !twilioPhoneNumber || !recipientPhoneNumber) {
    console.error('Faltan variables de entorno de Twilio. Verifica tu archivo .env');
    process.exit(1);
}

const twilioClient = twilio(accountSid, authToken);

// Variable para controlar si se pueden enviar SMS
let canSendSMS = true;

// Objetos para rastrear inactividad
const lastLocations = {}; // Última ubicación conocida por dispositivo
const lastZeroSpeedTimes = {}; // Tiempo en que la velocidad fue 0 por primera vez
const lastLocationChangeTimes = {}; // Tiempo en que la ubicación cambió por última vez
const alertSent = {}; // Para evitar enviar múltiples alertas/SMS
const INACTIVITY_THRESHOLD = 7 * 60 * 1000; // 7 minutos en milisegundos

// Función para obtener el nombre del lugar desde Google Maps Geocoding API o Nominatim como respaldo
async function getPlaceName(lat, lng) {
    // Validar coordenadas
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        console.error(`Coordenadas inválidas: lat=${lat}, lng=${lng}`);
        return "Ubicación desconocida (coordenadas inválidas)";
    }

    // Intentar con Google Maps Geocoding API
    try {
        console.log(`Solicitando nombre del lugar a Google Maps para ${lat}, ${lng}`);
        const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=AIzaSyD-jiDxqTS_5ey5hr9WdaUO3AJ0Q4N_-MM`);
        if (!response.ok) {
            throw new Error(`Error ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        if (data.status === "OK" && data.results && data.results.length > 0) {
            const placeName = data.results[0].formatted_address;
            console.log(`Nombre del lugar obtenido de Google Maps: ${placeName}`);
            return placeName;
        } else {
            console.log(`No se encontraron resultados en Google Maps para ${lat}, ${lng}. Estado: ${data.status}`);
            throw new Error(`No se encontraron resultados. Estado: ${data.status}`);
        }
    } catch (error) {
        console.error(`Error al obtener el nombre del lugar de Google Maps para ${lat}, ${lng}:`, error.message);
        // Intentar con Nominatim como respaldo
        try {
            console.log(`Intentando con API alternativa (Nominatim) para ${lat}, ${lng}`);
            const nominatimResponse = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
            if (!nominatimResponse.ok) {
                throw new Error(`Error ${nominatimResponse.status}: ${nominatimResponse.statusText}`);
            }
            const nominatimData = await nominatimResponse.json();
            if (nominatimData && nominatimData.display_name) {
                const placeName = nominatimData.display_name;
                console.log(`Nombre del lugar obtenido de Nominatim: ${placeName}`);
                return placeName;
            } else {
                console.log(`No se encontraron resultados en Nominatim para ${lat}, ${lng}`);
                return "Ubicación desconocida (error en APIs)";
            }
        } catch (nominatimError) {
            console.error(`Error al obtener el nombre del lugar de Nominatim para ${lat}, ${lng}:`, nominatimError.message);
            return "Ubicación desconocida (error en APIs)";
        }
    }
}

// Función para verificar inactividad y enviar SMS
const checkInactivity = () => {
    console.log('Verificando inactividad...');
    const query = `
        SELECT l.device_id, l.lat, l.lng, l.speed, l.timestamp, d.name 
        FROM locations l
        LEFT JOIN devices d ON l.device_id = d.device_id
        WHERE l.timestamp = (
            SELECT MAX(timestamp)
            FROM locations
            WHERE device_id = l.device_id
        )
        GROUP BY l.device_id
    `;
    db.query(query, async (err, results) => {
        if (err) {
            console.error('Error al verificar inactividad:', err);
            return;
        }
        if (!results || results.length === 0) {
            console.log('No hay ubicaciones registradas para verificar inactividad');
            return;
        }

        const now = new Date();
        for (const location of results) {
            const deviceId = location.device_id;
            const lat = location.lat;
            const lng = location.lng;
            const speed = location.speed || 0;
            const timestamp = new Date(location.timestamp);

            // Actualizar la última ubicación conocida
            const currentLocation = { lat, lng };
            if (!lastLocations[deviceId]) {
                lastLocations[deviceId] = currentLocation;
                lastLocationChangeTimes[deviceId] = now.getTime();
            }

            // Verificar si la ubicación ha cambiado (usamos una tolerancia de 10 metros)
            const hasLocationChanged = lastLocations[deviceId] && (
                Math.abs(lastLocations[deviceId].lat - lat) > 0.0001 || // Aproximadamente 10 metros
                Math.abs(lastLocations[deviceId].lng - lng) > 0.0001
            );

            if (hasLocationChanged) {
                console.log(`Dispositivo ${deviceId} cambió de ubicación. Reiniciando temporizador.`);
                lastLocations[deviceId] = currentLocation;
                lastLocationChangeTimes[deviceId] = now.getTime();
                delete lastZeroSpeedTimes[deviceId];
                delete alertSent[deviceId]; // Permitir nuevas alertas si la unidad se mueve
            } else {
                lastLocations[deviceId] = currentLocation;
            }

            // Verificar velocidad 0 km/h
            if (speed === 0) {
                if (!lastZeroSpeedTimes[deviceId]) {
                    lastZeroSpeedTimes[deviceId] = now.getTime();
                    console.log(`Dispositivo ${deviceId} con velocidad 0. Iniciando temporizador.`);
                }
            } else {
                delete lastZeroSpeedTimes[deviceId];
                delete alertSent[deviceId]; // Permitir nuevas alertas si la unidad se mueve
            }

            // Calcular tiempo de inactividad basado en velocidad 0 o misma ubicación
            const timeSinceZeroSpeed = lastZeroSpeedTimes[deviceId] ? now.getTime() - lastZeroSpeedTimes[deviceId] : Infinity;
            const timeSinceLocationChange = lastLocationChangeTimes[deviceId] ? now.getTime() - lastLocationChangeTimes[deviceId] : Infinity;
            const inactivityTime = Math.min(timeSinceZeroSpeed, timeSinceLocationChange);

            console.log(`Dispositivo ${deviceId}: Tiempo de inactividad: ${(inactivityTime / 1000 / 60).toFixed(2)} minutos`);

            // Detectar inactividad después de 7 minutos
            if (inactivityTime >= INACTIVITY_THRESHOLD) {
                const driverName = location.name || `Chofer ${deviceId}`;
                const lastUpdateLocal = timestamp.toLocaleString('es-MX', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
                const placeName = await getPlaceName(lat, lng);
                const message = `${driverName} (ID: ${deviceId}) lleva más de 7 minutos detenido en ${placeName}. Última actualización: ${lastUpdateLocal}`;
                console.log('Detectada inactividad:', message);

                // Enviar alerta al dashboard
                io.emit('adminAlert', { deviceId, message });

                // Enviar SMS solo si no se ha enviado antes para este período de inactividad y si está permitido
                if (!alertSent[deviceId] && canSendSMS) {
                    console.log(`Enviando SMS para ${deviceId}`);
                    twilioClient.messages
                        .create({
                            body: message,
                            from: twilioPhoneNumber,
                            to: recipientPhoneNumber
                        })
                        .then(msg => {
                            console.log(`SMS enviado con SID: ${msg.sid}`);
                            alertSent[deviceId] = true; // Marcar como enviado
                            io.emit('adminAlert', { deviceId, message: `SMS enviado al supervisor: ${message}` });
                        })
                        .catch(error => {
                            console.error('Error al enviar SMS:', error.message, error.code);
                            if (error.message.includes('exceeded the null daily messages limit')) {
                                canSendSMS = false; // Desactivar envío de SMS si se excede el límite
                                console.log('Límite diario de SMS alcanzado. Desactivando envío de SMS.');
                            }
                            io.emit('adminAlert', { deviceId, message: `Error al enviar SMS: ${error.message}` });
                        });
                } else if (!canSendSMS) {
                    console.log(`No se puede enviar SMS para ${deviceId}: límite diario alcanzado`);
                    io.emit('adminAlert', { deviceId, message: `No se pudo enviar SMS: límite diario alcanzado` });
                } else {
                    console.log(`SMS ya enviado previamente para ${deviceId}`);
                }
            }
        }
    });
};

// Verificar inactividad cada 15 segundos
setInterval(checkInactivity, 15000);

// Configuración de Socket.IO
io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);
    socket.on('registerDevice', (deviceId) => {
        socket.deviceId = deviceId;
        console.log(`Dispositivo registrado: ${deviceId}`);
        socket.join(deviceId);
    });

    socket.on('startTrip', (deviceId) => {
        console.log(`Viaje iniciado para ${deviceId}`);
        io.emit('tripStarted', deviceId);
    });

    socket.on('endTrip', (deviceId) => {
        console.log(`Viaje finalizado para ${deviceId}`);
        io.emit('tripEnded', deviceId);
    });

    socket.on('inactivityAlert', (alert) => {
        console.log('Alerta de inactividad recibida:', alert);
        io.emit('adminAlert', alert);
        io.to(alert.deviceId).emit('driverAlert', 'Por favor, continúe su ruta. Ha estado inactivo por más de 7 minutos.');
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
    });
});

// Rutas de la API
app.post('/api/location', async (req, res) => {
    const { deviceId, lat, lng, speed } = req.body;
    console.log('Datos recibidos:', { deviceId, lat, lng, speed });

    if (!deviceId || lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng)) {
        console.log('Datos inválidos:', { deviceId, lat, lng, speed });
        return res.status(400).json({ error: 'Datos incompletos o inválidos', received: { deviceId, lat, lng, speed } });
    }

    const placeName = await getPlaceName(lat, lng);

    const query = 'INSERT INTO locations (device_id, lat, lng, speed, timestamp) VALUES (?, ?, ?, ?, NOW())';
    db.query(query, [deviceId, lat, lng, speed || 0], (err, result) => {
        if (err) {
            console.error('Error al insertar ubicación:', err.code, err.sqlMessage, { deviceId, lat, lng, speed });
            return res.status(500).json({ error: 'Error interno del servidor', code: err.code, message: err.sqlMessage });
        }
        io.emit('updateLocation', { device_id: deviceId, lat, lng, speed: speed || 0, placeName });
        res.json({ status: 'success', id: result.insertId });
    });
});

app.get('/api/devices', (req, res) => {
    const query = 'SELECT device_id, name FROM devices';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener dispositivos:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

app.get('/api/locations', (req, res) => {
    const deviceId = req.query.deviceId;
    let query = 'SELECT device_id, lat, lng, speed, timestamp FROM locations ORDER BY timestamp DESC LIMIT 100';
    let params = [];
    
    if (deviceId) {
        query = 'SELECT device_id, lat, lng, speed, timestamp FROM locations WHERE device_id = ? ORDER BY timestamp DESC LIMIT 100';
        params = [deviceId];
    }

    db.query(query, params, (err, results) => {
        if (err) {
            console.error('Error al obtener ubicaciones:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

app.post('/api/assignRoute', (req, res) => {
    const { deviceId, routeName, destinations } = req.body;

    if (!deviceId || !routeName || !destinations || !Array.isArray(destinations)) {
        console.log('Datos inválidos para asignar ruta:', req.body);
        return res.status(400).json({ error: 'Datos incompletos o inválidos' });
    }

    const coordinates = JSON.stringify(destinations.map((dest, index) => ({
        order: index + 1,
        lat: dest.lat,
        lng: dest.lng
    })));

    const query = 'INSERT INTO routes (device_id, route_name, coordinates) VALUES (?, ?, ?)';
    db.query(query, [deviceId, routeName, coordinates], (err, result) => {
        if (err) {
            console.error('Error al guardar ruta:', err);
            return res.status(500).json({ error: 'Error al guardar la ruta' });
        }
        console.log(`Ruta "${routeName}" asignada a ${deviceId}`);
        res.json({ success: true, id: result.insertId });
    });
});

app.get('/api/routes', (req, res) => {
    const deviceId = req.query.deviceId;
    if (!deviceId) {
        console.log('Falta deviceId en solicitud de rutas');
        return res.status(400).json({ error: 'Se requiere deviceId' });
    }

    const query = 'SELECT route_name, coordinates FROM routes WHERE device_id = ? ORDER BY id DESC LIMIT 1';
    db.query(query, [deviceId], (err, results) => {
        if (err) {
            console.error('Error al obtener rutas:', err);
            return res.status(500).json({ error: 'Error al obtener rutas' });
        }
        if (results.length === 0) {
            console.log(`No se encontraron rutas para ${deviceId}`);
            return res.status(404).json({ error: 'No se encontraron rutas para este dispositivo' });
        }
        const destinations = JSON.parse(results[0].coordinates).map(coord => ({
            lat: coord.lat,
            lng: coord.lng
        }));
        res.json(destinations);
    });
});

// Iniciar el servidor
server.listen(port, '0.0.0.0', () => {
    console.log(`Servidor corriendo en puerto ${port}`);
});

// Manejo de errores no capturados
process.on('uncaughtException', (err) => {
    console.error('Error no capturado:', err);
});