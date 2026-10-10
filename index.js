require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(express.static('public'));

let allScannedPairs = [];   
let matchedTrades = [];     
let overallHistory = [];
let recentAlerts = [];

async function fetchBatchSolanaPairs() {
    try {
        const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana', { timeout: 5000 }).catch(() => ({ data: { pairs: [] } }));
        if (res.data && res.data.pairs) {
            // Sirf Solana network ke pairs aur non-major coins filter karna
            return res.data.pairs.filter(p => p.chainId === 'solana');
        }
        return [];
    } catch (err) {
        console.log("Fetch Error:", err.message);
        return [];
    }
}

async function scanAndProcessMarket() {
    try {
        const fetchedPairs = await fetchBatchSolanaPairs();
        if (!fetchedPairs || fetchedPairs.length === 0) return;

        let tempAllPairs = [];

        // Major tokens ya stablecoins ki list jinhain exclude karna hai (Taake sirf memecoins bachein)
        const ignoredSymbols = ['SOL', 'USDC', 'USDT', 'WBTC', 'WETH', 'JTO', 'JUP', 'PYTH', 'BSOL', 'MSOL', 'BNSOL'];

        for (let mainPair of fetchedPairs) {
            const symbol = mainPair.baseToken.symbol ? mainPair.baseToken.symbol.toUpperCase() : '';
            const quoteSymbol = mainPair.quoteToken.symbol ? mainPair.quoteToken.symbol.toUpperCase() : '';

            // ❌ Skip agar base token ya symbol major crypto / stablecoin nikle
            if (ignoredSymbols.includes(symbol) || ignoredSymbols.includes(quoteSymbol)) {
                continue;
            }

            const tokenAddress = mainPair.baseToken.address;
            const priceUsd = parseFloat(mainPair.priceUsd || 0);
            const priceChange1h = mainPair.priceChange?.h1 || 0;
            const priceChange24h = mainPair.priceChange?.h24 || 0;
            const volume24h = mainPair.volume?.h24 || 0;
            
            let liquidityUsd = 0;
            if (mainPair.liquidity) {
                liquidityUsd = parseFloat(mainPair.liquidity.usd || mainPair.liquidity.base || 0);
            }

            const txns = mainPair.txns?.h1 || { buys: 0, sells: 0 };

            const estimatedProfitFactor = (priceChange1h > 0) ? (1 + priceChange1h / 100) : 1;
            const potentialProfitFrom10 = 10 * estimatedProfitFactor;

            let priority = null;
            let statusLabel = "⏳ Monitoring";

            // Strategy Filters ($10 investment base)
            if (potentialProfitFrom10 >= 1000 || volume24h >= 100000) {
                priority = 1;
                statusLabel = potentialProfitFrom10 >= 1000 ? "🔥 High Priority ($10➔$1k+)" : "🐋 Whale Action";
            } 
            else if (potentialProfitFrom10 >= 300 || (priceChange1h >= 300 && volume24h >= 20000)) {
                priority = 2;
                statusLabel = "⚡ Medium Priority ($10➔$300)";
            }

            tempAllPairs.push({
                address: tokenAddress,
                symbol: mainPair.baseToken.symbol,
                name: mainPair.baseToken.name || mainPair.baseToken.symbol,
                price: priceUsd,
                priceChange1h: priceChange1h,
                priceChange24h: priceChange24h,
                volume24h: volume24h,
                liquidity: liquidityUsd,
                txns: txns,
                chartUrl: mainPair.url,
                matched: priority !== null,
                status: statusLabel
            });

            // Strategy Trigger ($10 Position)
            if (priority !== null) {
                let existingTrade = matchedTrades.find(t => t.address === tokenAddress);

                if (!existingTrade && priceUsd > 0) {
                    matchedTrades.push({
                        address: tokenAddress,
                        symbol: mainPair.baseToken.symbol,
                        buyPrice: priceUsd,
                        currentPrice: priceUsd,
                        initialInvestment: 10,
                        currentValue: 10,
                        pnlPercentage: 0,
                        txns: txns,
                        chartUrl: mainPair.url,
                        signalTime: new Date().toLocaleTimeString(),
                        priority: priority,
                        status: statusLabel,
                        isClosed: false,
                        exitReason: "🟢 Active Position ($10)"
                    });

                    recentAlerts.unshift({
                        time: new Date().toLocaleTimeString(),
                        text: `🚀 Memecoin Match: ${mainPair.baseToken.symbol} at $${priceUsd}`
                    });
                    if (recentAlerts.length > 10) recentAlerts.pop();
                }
            }
        }

        allScannedPairs = tempAllPairs.slice(0, 50);

        // Active Trades Real-Time Sync
        let totalVal = 0;
        let totalInvested = 0;

        for (let trade of matchedTrades) {
            if (trade.isClosed) {
                totalVal += trade.currentValue;
                totalInvested += trade.initialInvestment;
                continue;
            }

            const livePairData = allScannedPairs.find(p => p.address === trade.address);
            if (livePairData) {
                trade.currentPrice = livePairData.price;
                trade.txns = livePairData.txns;
                const priceRatio = livePairData.price / trade.buyPrice;
                trade.currentValue = parseFloat((trade.initialInvestment * priceRatio).toFixed(2));
                trade.pnlPercentage = parseFloat((((livePairData.price - trade.buyPrice) / trade.buyPrice) * 100).toFixed(2));

                let closeReason = null;
                if (trade.pnlPercentage <= -20) {
                    closeReason = "🛡️ Stop-Loss Triggered (-20%)";
                } else if (trade.pnlPercentage >= 100) {
                    closeReason = "🎯 Take-Profit Secured (+100%)";
                }

                if (closeReason) {
                    trade.isClosed = true;
                    trade.exitReason = closeReason;
                    recentAlerts.unshift({
                        time: new Date().toLocaleTimeString(),
                        text: `⚠️ Position Closed (${trade.symbol}): ${closeReason}`
                    });
                }
            }
            totalVal += trade.currentValue;
            totalInvested += trade.initialInvestment;
        }

        if (matchedTrades.length > 0) {
            if (overallHistory.length > 20) overallHistory.shift();
            overallHistory.push({
                time: new Date().toLocaleTimeString(),
                totalValue: totalVal,
                totalInvested: totalInvested
            });
        }

    } catch (err) {
        console.log("Scanner Error:", err.message);
    }
}

app.get('/api/dashboard', async (req, res) => {
    await scanAndProcessMarket();
    res.json({
        allPairs: allScannedPairs,
        matchedTrades: matchedTrades,
        history: overallHistory,
        alerts: recentAlerts
    });
});

app.listen(PORT, () => {
    console.log(`\n==========================================`);
    console.log(`🌐 Pure Memecoin Solana Terminal: http://localhost:${PORT}`);
    console.log(`==========================================\n`);
});