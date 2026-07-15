# TradeOsphere

A complete, modern web app for trading simulation and analysis, with authentication and real-time stock data.

## Features
- Complete Authentication (Signup, Signin, Logout) with JWT securely stored in HttpOnly cookies.
- Protected Dashboard that automatically redirects to login if the user is unauthenticated.
- Real-time stock data fetching powered by [Finnhub](https://finnhub.io/).
- Backend Node.js server masking API keys securely.

## Setup Instructions

1. **Install Dependencies**
   Make sure you have Node.js installed. Open a terminal in this directory and run:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   - Copy `.env.example` to a new file called `.env`.
   - Sign up for a free Finnhub account at [https://finnhub.io/](https://finnhub.io/) to get an API key.
   - Replace `your_finnhub_api_key_here` in the `.env` file with your actual Finnhub API key.

3. **Run the Server**
   ```bash
   node server.js
   ```
   The database (`database.sqlite`) will automatically be created on the first run.

4. **Open the App**
   Navigate to `http://localhost:3000` in your web browser. You will be redirected to the signin page. Enjoy trading!
