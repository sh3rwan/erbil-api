const express = require('express');
const cors = require('cors');
const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 3000;

// 1. CRITICAL FIX: Enable CORS for ALL origins
// This stops the "Failed to fetch" error on your widget
app.use(cors()); 

// --- Data Simulation ---
// We generate realistic fake data to guarantee your widget always has something to show
let flightDataCache = {
    flights: [],
    lastFetched: null
};

function generateFlight(type, id) {
    const isDeparture = type === 'departures';
    const cities = isDeparture 
        ? ['Dubai', 'Istanbul', 'Doha', 'Amman', 'Frankfurt', 'Vienna', 'Suleimaniyah'] 
        : ['Cairo', 'Beirut', 'London', 'Moscow', 'Munich', 'Baghdad', 'Stockholm'];
    const airlines = ['Emirates', 'Turkish Airlines', 'Qatar Airways', 'Royal Jordanian', 'Lufthansa', 'Austrian Airlines', 'Fly Baghdad'];
    const statuses = isDeparture 
        ? ['Scheduled', 'Boarding', 'Delayed', 'Cancelled'] 
        : ['Scheduled', 'Delayed', 'Landed', 'Cancelled'];

    const city = cities[Math.floor(Math.random() * cities.length)];
    const airline = airlines[Math.floor(Math.random() * airlines.length)];
    const status = statuses[Math.floor(Math.random() * statuses.length)];

    const time = new Date();
    time.setHours(time.getHours() + Math.floor(Math.random() * 5) - 2); 
    time.setMinutes(Math.floor(Math.random() * 60));

    return {
        id: id,
        type: isDeparture ? 'Departure' : 'Arrival',
        flightNo: `${airline.substring(0, 2).toUpperCase()}${Math.floor(Math.random() * 900) + 100}`,
        city: city,
        airline: airline,
        scheduled: time.toISOString(), 
        status: status,
    };
}

function refreshCache() {
    console.log("Refreshing data...");
    const newFlights = [];
    for (let i = 1; i <= 8; i++) {
        newFlights.push(generateFlight('arrivals', `A${i}`));
        newFlights.push(generateFlight('departures', `D${i}`));
    }
    newFlights.sort((a, b) => new Date(a.scheduled) - new Date(b.scheduled));
    flightDataCache.flights = newFlights;
    flightDataCache.lastFetched = new Date().toISOString();
}

// Initial load
refreshCache();

// --- API Routes ---

app.get('/health', (req, res) => res.send('OK'));

app.post('/api/flights/refresh', (req, res) => {
    refreshCache();
    res.json({ success: true, message: "Refreshed" });
});

app.get('/api/flights', (req, res) => res.json(flightDataCache));

app.get('/api/flights/arrivals', (req, res) => {
    const arrivals = flightDataCache.flights.filter(f => f.type === 'Arrival');
    res.json({ ...flightDataCache, flights: arrivals });
});

app.get('/api/flights/departures', (req, res) => {
    const departures = flightDataCache.flights.filter(f => f.type === 'Departure');
    res.json({ ...flightDataCache, flights: departures });
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// REQUIRED FOR VERCEL
module.exports = app;
