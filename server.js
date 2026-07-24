const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const FINNHUB_API_KEY = 'd9dkkl1r01qui7p2j8vgd9dkkl1r01qui7p2j900';
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

            db.run(`CREATE TABLE IF NOT EXISTS watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                ticker TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id),
                UNIQUE(user_id, ticker)
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
                quotes = await Promise.all(tickers.map(async t => {
                    try {
                        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${t}&token=${FINNHUB_API_KEY}`);
                        const data = await res.json();
                        return { symbol: t, regularMarketPrice: data.c, regularMarketPreviousClose: data.pc, regularMarketChangePercent: data.dp };
                    } catch(e) { return null; }
                }));
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
        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`);
        const quote = await res.json();
        if (!quote || !quote.c || quote.c === 0) return res.status(400).json({ error: 'Invalid ticker symbol or no price data' });
        
        const price = quote.c;
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

app.get('/api/stock/search/:query', requireAuth, async (req, res) => {
    try {
        const fetchRes = await fetch(`https://finnhub.io/api/v1/search?q=${req.params.query}&token=${FINNHUB_API_KEY}`);
        const result = await fetchRes.json();
        // Map to expected frontend structure
        res.json({ quotes: result.result.map(r => ({ symbol: r.displaySymbol, longname: r.description, quoteType: 'EQUITY' })) });
    } catch (err) {
        res.status(500).json({ error: 'Error searching' });
    }
});

app.get('/api/stock/quote/:ticker', requireAuth, async (req, res) => {
    try {
        const ticker = req.params.ticker;
        const [quoteRes, profileRes] = await Promise.all([
            fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`).then(r => r.json()),
            fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_API_KEY}`).then(r => r.json())
        ]);
        
        const mappedQuote = {
            symbol: ticker,
            regularMarketPrice: quoteRes.c,
            regularMarketChange: quoteRes.d,
            regularMarketChangePercent: quoteRes.dp,
            regularMarketOpen: quoteRes.o,
            regularMarketDayHigh: quoteRes.h,
            regularMarketDayLow: quoteRes.l,
            regularMarketPreviousClose: quoteRes.pc,
            longName: profileRes.name || ticker,
            sector: profileRes.finnhubIndustry || 'Equities',
            marketCap: profileRes.marketCapitalization ? profileRes.marketCapitalization * 1000000 : null,
            regularMarketVolume: null // Finnhub quote doesn't return volume in standard tier easily, keep null
        };
        res.json(mappedQuote);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching quote' });
    }
});

app.get('/api/stock/history/:ticker/:range', requireAuth, async (req, res) => {
    try {
        const { ticker, range } = req.params;
        let period1, interval;
        const now = new Date();
        
        if (range === '1D') {
            period1 = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
            interval = '5m';
        } else if (range === '5D') {
            period1 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            interval = '15m';
        } else if (range === '1M') {
            period1 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            interval = '1d';
        } else if (range === '3M') {
            period1 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            interval = '1d';
        } else if (range === '6M') {
            period1 = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
            interval = '1d';
        } else if (range === '1Y') {
            period1 = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
            interval = '1d';
        } else if (range === '5Y') {
            period1 = new Date(now.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
            interval = '1wk';
        } else {
            period1 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            interval = '1d';
        }

        const result = await yahooFinance.chart(ticker, { period1, interval });
        
        if (!result.quotes || result.quotes.length === 0) return res.json([]);
        
        const chartData = result.quotes.map(q => ({
            time: interval.endsWith('m') ? Math.floor(new Date(q.date).getTime() / 1000) : new Date(q.date).toISOString().split('T')[0],
            open: q.open,
            high: q.high,
            low: q.low,
            close: q.close,
            value: q.close
        })).filter(q => q.close !== null);
        
        res.json(chartData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching historical data' });
    }
});

// Periodic Finnhub fetching and WebSocket broadcasting
const globalWatchlist = new Set(['AAPL', 'MSFT', 'TSLA', 'GOOGL', 'AMZN', 'NVDA', 'META', 'SPY', 'QQQ']);

// Load all unique tickers from watchlist on startup
db.all(`SELECT DISTINCT ticker FROM watchlist`, [], (err, rows) => {
    if (!err && rows) {
        rows.forEach(r => globalWatchlist.add(r.ticker));
    }
});

let currentWatchlistIndex = 0;
const MAX_REQUESTS_PER_CRON = 8; // 6 runs/min * 8 reqs = 48 reqs/min (leaves room under 60 limit)

cron.schedule('*/10 * * * * *', async () => {
    try {
        const allTickers = Array.from(globalWatchlist);
        if (allTickers.length === 0) return;

        // Take a chunk of up to MAX_REQUESTS_PER_CRON items
        const tickersToFetch = [];
        const numToFetch = Math.min(MAX_REQUESTS_PER_CRON, allTickers.length);

        for (let i = 0; i < numToFetch; i++) {
            if (currentWatchlistIndex >= allTickers.length) {
                currentWatchlistIndex = 0;
            }
            tickersToFetch.push(allTickers[currentWatchlistIndex]);
            currentWatchlistIndex++;
        }

        const quotes = await Promise.all(tickersToFetch.map(async ticker => {
            try {
                const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`);
                if (!res.ok) return null; // Avoid crashing on 429 or other errors
                const data = await res.json();
                return {
                    symbol: ticker,
                    price: data.c,
                    change: data.d,
                    changePercent: data.dp
                };
            } catch(e) { return null; }
        }));

        const marketData = quotes.filter(q => q && q.price && q.price !== 0);
        if (marketData.length > 0) {
            io.emit('marketUpdate', marketData);
        }
    } catch (err) {
        console.error('Error fetching market updates', err);
    }
});

// Watchlist API Endpoints
app.get('/api/watchlist', requireAuth, (req, res) => {
    db.all(`SELECT ticker FROM watchlist WHERE user_id = ?`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows.map(r => r.ticker));
    });
});

app.post('/api/watchlist', requireAuth, (req, res) => {
    const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: 'Ticker is required' });
    
    db.run(`INSERT OR IGNORE INTO watchlist (user_id, ticker) VALUES (?, ?)`, [req.user.id, ticker], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        globalWatchlist.add(ticker);
        res.json({ message: 'Added to watchlist' });
    });
});

app.delete('/api/watchlist/:ticker', requireAuth, (req, res) => {
    const ticker = req.params.ticker;
    db.run(`DELETE FROM watchlist WHERE user_id = ? AND ticker = ?`, [req.user.id, ticker], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ message: 'Removed from watchlist' });
    });
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

app.use(express.static(path.join(__dirname, ''), { etag: false, maxAge: 0 }));

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
