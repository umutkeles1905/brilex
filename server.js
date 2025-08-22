const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Basit test endpoint
app.get('/api/status', (req, res) => {
    res.json({
        status: 'ok',
        temperature: 25,
        target: 0,
        message: 'BriLeX Dental Furnace Ready!'
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 BriLeX Server: http://localhost:${PORT}`);
});
