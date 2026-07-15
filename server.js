const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const cron = require('node-cron');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-do-not-use-in-production';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Database Setup
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error opening database', err);
    } else {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                email TEXT UNIQUE,
                password_hash TEXT,
                balance REAL DEFAULT 1000000.0
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS portfolio (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                ticker TEXT,
                quantity INTEGER,
                average_price REAL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                ticker TEXT,
                type TEXT,
                quantity INTEGER,
                price REAL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )`);
        });
    }
});

// Auth Middleware
const requireAuth = (req, res, next) => {
    const token = req.cookies.jwt;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Unauthorized' });
        req.user = decoded;
        next();
    });
};

// API Routes
app.post('/api/signup', (req, res) => {
    const { name, email, password } = req.body;
    
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (row) return res.status(400).json({ error: 'Email already in use' });

        bcrypt.hash(password, 10, (err, hash) => {
            if (err) return res.status(500).json({ error: 'Hashing error' });

            db.run(`INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)`, [name, email, hash], function(err) {
                if (err) return res.status(500).json({ error: 'Database error' });
                
                const token = jwt.sign({ id: this.lastID, name, email }, JWT_SECRET, { expiresIn: '24h' });
                res.cookie('jwt', token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
                res.json({ message: 'Signup successful' });
            });
        });
    });
});

app.post('/api/signin', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(400).json({ error: 'Invalid email or password' });

        bcrypt.compare(password, user.password_hash, (err, match) => {
            if (err) return res.status(500).json({ error: 'Comparison error' });
            if (!match) return res.status(400).json({ error: 'Invalid email or password' });

            const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
            res.cookie('jwt', token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
            res.json({ message: 'Signin successful' });
        });
    });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('jwt');
    res.json({ message: 'Logged out successfully' });
});

app.get('/api/session', requireAuth, (req, res) => {
    db.get(`SELECT id, name, email, balance FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'User not found' });
        res.json({ user });
    });
});

app.get('/api/portfolio', requireAuth, (req, res) => {
    db.all(`SELECT ticker, quantity, average_price FROM portfolio WHERE user_id = ? AND quantity > 0`, [req.user.id], async (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        try {
            // Fetch live prices for all tickers in portfolio
            const tickers = rows.map(r => r.ticker);
            let quotes = [];
            if (tickers.length > 0) {
                quotes = await Promise.all(tickers.map(t => yahooFinance.quote(t).catch(() => null)));
            }
            const quoteMap = quotes.filter(q => q).reduce((acc, q) => ({ ...acc, [q.symbol]: q }), {});
            
            let totalInvested = 0;
            let currentValue = 0;
            let todaysChange = 0;
            
            const holdings = rows.map(r => {
                const q = quoteMap[r.ticker];
                const price = q ? q.regularMarketPrice : r.average_price;
                const prevClose = q ? q.regularMarketPreviousClose : r.average_price;
                
                const invested = r.quantity * r.average_price;
                const current = r.quantity * price;
                const today = r.quantity * (price - prevClose);
                
                totalInvested += invested;
                currentValue += current;
                todaysChange += today;
                
                return {
                    ticker: r.ticker,
                    quantity: r.quantity,
                    averagePrice: r.average_price,
                    currentPrice: price,
                    dayChangePercent: q ? q.regularMarketChangePercent : 0,
                    totalValue: current,
                    profitLoss: current - invested
                };
            });
            
            db.get(`SELECT balance FROM users WHERE id = ?`, [req.user.id], (err, user) => {
                if (err || !user) return res.status(500).json({ error: 'User not found' });
                res.json({
                    availableCash: user.balance,
                    totalPortfolioValue: user.balance + currentValue,
                    totalInvested,
                    currentValue,
                    overallProfitLoss: currentValue - totalInvested,
                    todaysProfitLoss: todaysChange,
                    holdings
                });
            });
        } catch(e) {
            console.error(e);
            res.status(500).json({ error: 'Error calculating portfolio' });
        }
    });
});

app.post('/api/trade', requireAuth, async (req, res) => {
    const { ticker, type, quantity } = req.body; // type: 'BUY' or 'SELL'
    const qty = parseInt(quantity, 10);
    if (!ticker || !type || isNaN(qty) || qty <= 0) {
        return res.status(400).json({ error: 'Invalid trade parameters' });
    }

    try {
        // Fetch real-time price via Yahoo Finance to execute the trade
        const quote = await yahooFinance.quote(ticker);
        if (!quote || !quote.regularMarketPrice) return res.status(400).json({ error: 'Invalid ticker symbol' });
        
        const price = quote.regularMarketPrice;
        const totalValue = price * qty;

        db.serialize(() => {
            db.get(`SELECT balance FROM users WHERE id = ?`, [req.user.id], (err, user) => {
                if (err || !user) return res.status(500).json({ error: 'User not found' });

                if (type === 'BUY') {
                    if (user.balance < totalValue) return res.status(400).json({ error: 'Insufficient virtual balance' });
                    
                    // Deduct balance
                    db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [totalValue, req.user.id]);
                    
                    // Update portfolio
                    db.get(`SELECT * FROM portfolio WHERE user_id = ? AND ticker = ?`, [req.user.id, ticker], (err, item) => {
                        if (item) {
                            const newQty = item.quantity + qty;
                            const newAvg = ((item.quantity * item.average_price) + totalValue) / newQty;
                            db.run(`UPDATE portfolio SET quantity = ?, average_price = ? WHERE id = ?`, [newQty, newAvg, item.id]);
                        } else {
                            db.run(`INSERT INTO portfolio (user_id, ticker, quantity, average_price) VALUES (?, ?, ?, ?)`, [req.user.id, ticker, qty, price]);
                        }
                    });
                } else if (type === 'SELL') {
                    db.get(`SELECT * FROM portfolio WHERE user_id = ? AND ticker = ?`, [req.user.id, ticker], (err, item) => {
                        if (err || !item || item.quantity < qty) return res.status(400).json({ error: 'Insufficient quantity to sell' });
                        
                        // Add balance
                        db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [totalValue, req.user.id]);
                        
                        // Update portfolio
                        const newQty = item.quantity - qty;
                        db.run(`UPDATE portfolio SET quantity = ? WHERE id = ?`, [newQty, item.id]);
                    });
                } else {
                    return res.status(400).json({ error: 'Invalid trade type' });
                }

                // Record transaction
                db.run(`INSERT INTO transactions (user_id, ticker, type, quantity, price) VALUES (?, ?, ?, ?, ?)`, [req.user.id, ticker, type, qty, price]);
                
                res.json({ message: 'Trade executed successfully', price, totalValue });
            });
        });
    } catch (err) {
        res.status(500).json({ error: 'Error executing trade' });
    }
});

app.get('/api/stock/history/:ticker', requireAuth, async (req, res) => {
    try {
        const { ticker } = req.params;
        // Get last 1 month of daily data for charting
        const result = await yahooFinance.historical(ticker, { period1: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], interval: '1d' });
        const chartData = result.map(day => ({
            time: day.date.toISOString().split('T')[0],
            value: day.close
        }));
        res.json(chartData);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching historical data' });
    }
});

// Periodic Yahoo Finance fetching and WebSocket broadcasting
const WATCHLIST = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'SBIN.NS', 'ICICIBANK.NS', 'ITC.NS', '^NSEI', '^BSESN'];

cron.schedule('*/10 * * * * *', async () => {
    try {
        const quotes = await Promise.all(WATCHLIST.map(ticker => yahooFinance.quote(ticker)));
        const marketData = quotes.map(q => ({
            symbol: q.symbol,
            price: q.regularMarketPrice,
            change: q.regularMarketChange,
            changePercent: q.regularMarketChangePercent
        }));
        io.emit('marketUpdate', marketData);
    } catch (err) {
        console.error('Error fetching market updates', err);
    }
});

io.on('connection', (socket) => {
    console.log('A client connected for real-time updates');
});

// Static files and protected routes
app.get('/', (req, res) => res.redirect('/start.html'));

app.get('/main.html', (req, res, next) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/start.html');
    jwt.verify(token, JWT_SECRET, (err) => {
        if (err) return res.redirect('/start.html');
        next();
    });
});

app.use(express.static(path.join(__dirname, '')));

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
