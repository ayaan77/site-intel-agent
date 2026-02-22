import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { executeAction } from './agent';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

app.use(bodyParser.json());

// Basic security: only allow requests from our site-intel brain
app.use((req, res, next) => {
    const origin = req.headers.origin;
    // In development, we might not always send an origin, so we relax this strictly for local dev if needed.
    // In production, this should be rigidly enforced.
    if (origin && origin !== ALLOWED_ORIGIN && process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    next();
});

// Health check endpoint
app.get('/status', (req, res) => {
    res.json({ status: 'online', agent: 'site-agent', version: '1.0.0' });
});

// Main execution endpoint
app.post('/execute', async (req, res) => {
    try {
        const { action, url, selector, text } = req.body;

        if (!action || !url) {
            return res.status(400).json({ error: 'Missing required parameters: action and url' });
        }

        console.log(`[EXECUTE] Action: ${action} | URL: ${url}`);

        const result = await executeAction({ action, url, selector, text });

        res.json(result);
    } catch (error: any) {
        console.error(`[ERROR] Execution failed:`, error.message);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

app.listen(PORT, () => {
    console.log(`🕷️ Site Agent running on http://localhost:${PORT}`);
    console.log(`🔒 Allowed origin: ${ALLOWED_ORIGIN}`);
});
