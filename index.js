const axios = require('axios');
const cheerio = require('cheerio');

// --- Global Cache ---
let flightCache = {
    data: [],
    lastFetched: 0,
    isStale: true,
};

const CACHE_LIFETIME = 15 * 60 * 1000; // 15 minutes in milliseconds
const SOURCE_URL = 'https://www.erbilairport.com/'; 
// --------------------

/**
 * Scrapes the Erbil Airport website for flight data.
 * @returns {Array<Object>} An array of flight objects.
 */
async function scrapeFlights() {
    console.log('--- Starting scrape ---');
    try {
        const response = await axios.get(SOURCE_URL, {
            // Use a standard User-Agent to prevent bot detection
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
            timeout: 15000 // 15 second timeout for the request
        });

        const $ = cheerio.load(response.data);
        const flights = [];

        // Select the main flight table rows
        // Note: The selector might need adjustment if the site structure changes.
        const flightRows = $('#FlightGrid tr[class*="FlightRow"]');
        
        if (flightRows.length === 0) {
            console.warn('Scraper found zero flight rows. Site structure may have changed.');
            return [];
        }

        flightRows.each((i, row) => {
            const cells = $(row).find('td');
            if (cells.length === 6) { // Ensure all 6 columns are present
                try {
                    const flightType = $(row).hasClass('ArrivalsFlightRow') ? 'Arrival' : 'Departure';
                    
                    // Extract data from cells (using 0-based index)
                    const scheduledTime = cells.eq(0).text().trim();
                    const flightNo = cells.eq(1).text().trim();
                    const city = cells.eq(2).text().trim();
                    const airline = cells.eq(3).text().trim();
                    const status = cells.eq(5).text().trim();

                    // Create a valid timestamp for the scheduled time using today's date
                    const now = new Date();
                    const [hour, minute] = scheduledTime.split(':').map(Number);
                    const scheduledDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);

                    // If the scheduled time is earlier than the current time, assume it's for tomorrow
                    // This handles overnight flights gracefully.
                    if (scheduledDate < now) {
                        scheduledDate.setDate(scheduledDate.getDate() + 1);
                    }
                    
                    flights.push({
                        type: flightType,
                        scheduled: scheduledDate.toISOString(), // Standard ISO format
                        flightNo: flightNo,
                        city: city,
                        airline: airline,
                        status: status,
                    });
                } catch (rowError) {
                    console.error(`Error processing flight row ${i}:`, rowError.message);
                }
            }
        });

        console.log(`--- Scrape completed. Found ${flights.length} flights ---`);
        return flights;

    } catch (error) {
        console.error('CRITICAL SCRAPING ERROR:', error.message);
        throw new Error(`Failed to access or parse the source website: ${error.message}`);
    }
}

/**
 * Ensures cache is populated or refreshed if stale.
 */
async function getCachedFlights(forceRefresh = false) {
    const now = Date.now();
    const cacheExpired = now - flightCache.lastFetched > CACHE_LIFETIME;

    if (forceRefresh || cacheExpired || flightCache.isStale) {
        console.log(`Cache update needed. Force: ${forceRefresh}, Expired: ${cacheExpired}, Stale: ${flightCache.isStale}`);
        try {
            const flights = await scrapeFlights();
            flightCache.data = flights;
            flightCache.lastFetched = now;
            flightCache.isStale = false;
            console.log(`Cache successfully updated at ${new Date(now).toTimeString()}`);
        } catch (error) {
            // If scrape fails, serve stale data if available, otherwise re-throw
            if (flightCache.data.length > 0 && !forceRefresh) {
                console.warn('Scrape failed. Serving existing STALE data.');
                flightCache.isStale = true; // Mark as stale again
            } else {
                throw error; // Re-throw if no data is available or if force refresh failed
            }
        }
    } else {
        console.log('Serving data from fresh cache.');
    }
    
    // Always return a deep copy of the cache to prevent external modification
    return JSON.parse(JSON.stringify(flightCache));
}

// --- Main Handler for Vercel Serverless Function ---

module.exports = async (req, res) => {
    // Set CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    
    // Set content type for JSON responses
    res.setHeader('Content-Type', 'application/json');

    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const path = url.pathname;

        if (req.method === 'POST' && path === '/api/flights/refresh') {
            // --- Force Refresh Logic (POST) ---
            await getCachedFlights(true); 
            // Return success status immediately after refresh (even if cache is empty due to scrape failure)
            res.status(200).send(JSON.stringify({ 
                success: true, 
                message: "Flight data refresh attempted.",
                lastFetched: new Date(flightCache.lastFetched).toISOString()
            }));
            return;
        }

        if (req.method === 'GET' && path.startsWith('/api/flights')) {
            // --- Fetch Data Logic (GET) ---
            
            // This ensures data is scraped if needed before proceeding
            const cacheResult = await getCachedFlights(false); 
            const allFlights = cacheResult.data;
            const lastFetchedTime = cacheResult.lastFetched;
            
            let filteredFlights = allFlights;
            let type = 'all';

            // Simple Path Routing for /api/flights/arrivals or /api/flights/departures
            if (path.endsWith('/arrivals')) {
                filteredFlights = allFlights.filter(f => f.type === 'Arrival');
                type = 'arrivals';
            } else if (path.endsWith('/departures')) {
                filteredFlights = allFlights.filter(f => f.type === 'Departure');
                type = 'departures';
            }
            
            // Sort flights by scheduled time (earliest first)
            filteredFlights.sort((a, b) => new Date(a.scheduled) - new Date(b.scheduled));

            const responsePayload = {
                flights: filteredFlights,
                type: type,
                lastFetched: new Date(lastFetchedTime).toISOString(),
                cacheStatus: cacheResult.isStale ? 'Stale' : 'Fresh',
            };

            res.status(200).send(JSON.stringify(responsePayload));
            return;
        }

        // --- Handle Unknown Routes ---
        res.status(404).send(JSON.stringify({ error: 'Not Found', message: 'Endpoint not supported.' }));

    } catch (error) {
        // --- Global Error Handler (This catches the crash) ---
        console.error('Global Invocation Error:', error);
        res.status(500).send(JSON.stringify({ 
            error: 'Internal Server Error', 
            message: 'A critical error occurred while processing the request.', 
            details: error.message 
        }));
    }
};
